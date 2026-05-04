import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Expense from "../models/Expense";
import Employee from "../models/Employee";
import LedgerAccount from "../models/LedgerAccount";
import {
  createJournalEntryRecord,
  resolveExpenseDebitAccount,
  resolveExpensePaymentAccount,
} from "../lib/journalPosting";

function generateExpenseReferenceNumber(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const randomSegment = String(Math.floor(Math.random() * 9000) + 1000);
  return `EXP-${year}${month}${day}-${randomSegment}`;
}

function isLegacyObjectIdReference(value: unknown): boolean {
  return typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value.trim());
}

async function ensureExpenseReference(expense: any): Promise<string> {
  const currentRef = String(expense.referenceNumber || "").trim();
  if (!currentRef || isLegacyObjectIdReference(currentRef)) {
    const nextRef = generateExpenseReferenceNumber();
    await Expense.findByIdAndUpdate(expense._id, { referenceNumber: nextRef });
    return nextRef;
  }
  return currentRef;
}

const router: Router = Router();

async function postExpenseJournalEntry(expense: any) {
  const amount = Number(expense.amount || 0);
  if (!amount || !expense._id) return;

  const reference = await ensureExpenseReference(expense);

  let expenseAccount = expense.expenseAccount
    ? await LedgerAccount.findById(expense.expenseAccount)
    : await resolveExpenseDebitAccount(String(expense.category || ""));
  let paymentAccount = expense.paymentAccount
    ? await LedgerAccount.findById(expense.paymentAccount)
    : await resolveExpensePaymentAccount(String(expense.paymentMethod || ""));

  if (!expenseAccount || !paymentAccount) {
    console.warn("Skipped expense journal entry: missing expense or payment account mapping");
    return;
  }

  const updatePayload: any = {};
  if (!expense.expenseAccount) updatePayload.expenseAccount = expenseAccount._id;
  if (!expense.paymentAccount) updatePayload.paymentAccount = paymentAccount._id;
  if (Object.keys(updatePayload).length > 0) {
    await Expense.findByIdAndUpdate(expense._id, updatePayload);
  }

  const lines = [
    {
      account: expenseAccount._id,
      accountName: expenseAccount.title,
      debit: amount,
      credit: 0,
      note: `Expense ${expense.title || expense._id}`,
    },
    {
      account: paymentAccount._id,
      accountName: paymentAccount.title,
      debit: 0,
      credit: amount,
      note: `Expense ${expense.title || expense._id}`,
    },
  ];

  try {
    await createJournalEntryRecord({
      date: expense.date || new Date(),
      reference,
      description: `Expense ${expense.title || "entry"}`,
      lines,
      source: "EXPENSE",
      sourceId: expense._id,
      postedBy: expense.addedBy,
    });
  } catch (err: any) {
    if (err?.message === "Journal entry already exists for this source") return;
    console.error("Failed to create expense journal entry:", err);
  }
}

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { category, month, year, page = "1", limit = "50" } = req.query as Record<string, string>;

    const query: any = {};
    if (category) query.category = category;
    if (month && year) {
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const total = await Expense.countDocuments(query);
    const expenses = await Expense.find(query)
      .populate("addedBy", "name")
      .populate("linkedEmployee", "name position department salary salaryType")
      .populate("expenseAccount", "title code type")
      .populate("paymentAccount", "title code type")
      .sort({ date: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const expensesWithRefs = await Promise.all(
      expenses.map(async (expense) => {
        const referenceNumber = await ensureExpenseReference(expense);
        return { ...expense, referenceNumber };
      })
    );

    const summary = await Expense.aggregate([
      { $match: query },
      { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);

    const grandTotal = summary.reduce((sum, s) => sum + s.total, 0);

    return sendSuccess(res, { expenses: expensesWithRefs, total, summary, grandTotal, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("Get expenses error:", error);
    return sendError(res, "Failed to fetch expenses", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    // Validate payroll expense requirements
    if (req.body.category === "payroll") {
      if (!req.body.linkedEmployeeId) {
        return sendError(res, "Employee required for payroll expenses", 400);
      }
      
      // Verify employee exists
      const employee = await Employee.findById(req.body.linkedEmployeeId);
      if (!employee) {
        return sendError(res, "Selected employee not found", 404);
      }
      
      // Set employeeSalaryType from employee record (snapshot)
      req.body.employeeSalaryType = employee.salaryType || null;
      req.body.linkedEmployee = req.body.linkedEmployeeId;
    } else {
      // Non-payroll expenses don't have linked employee
      req.body.linkedEmployee = null;
      req.body.employeeSalaryType = null;
    }
    
    delete req.body.linkedEmployeeId; // Remove if present from frontend
    const requestedRef = String(req.body.referenceNumber || "").trim();
    const referenceNumber = requestedRef || generateExpenseReferenceNumber();
    const expense = await Expense.create({ ...req.body, addedBy: req.user.id, referenceNumber });
    
    // Fetch saved expense with the final referenceNumber
    const savedExpense = await Expense.findById(expense._id)
      .populate("addedBy", "name")
      .populate("linkedEmployee", "name position department salary salaryType")
      .populate("expenseAccount", "title code type")
      .populate("paymentAccount", "title code type")
      .lean();
    
    // Post journal entry with the proper reference
    await postExpenseJournalEntry(savedExpense);
    
    return sendSuccess(res, savedExpense, "Expense added successfully", 201);
  } catch (error) {
    console.error("Add expense error:", error);
    return sendError(res, "Failed to add expense", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    // Validate payroll expense requirements for updates
    if (req.body.category === "payroll") {
      if (req.body.linkedEmployeeId) {
        const employee = await Employee.findById(req.body.linkedEmployeeId);
        if (!employee) {
          return sendError(res, "Selected employee not found", 404);
        }
        req.body.employeeSalaryType = employee.salaryType || null;
        req.body.linkedEmployee = req.body.linkedEmployeeId;
      }
    } else {
      // Non-payroll expenses don't have linked employee
      req.body.linkedEmployee = null;
      req.body.employeeSalaryType = null;
    }
    
    delete req.body.linkedEmployeeId;
    const expense = await Expense.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!expense) return sendError(res, "Expense not found", 404);
    return sendSuccess(res, expense, "Expense updated");
  } catch (error) {
    return sendError(res, "Failed to update expense", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const expense = await Expense.findByIdAndDelete(req.params.id);
    if (!expense) return sendError(res, "Expense not found", 404);
    return sendSuccess(res, null, "Expense deleted");
  } catch (error) {
    return sendError(res, "Failed to delete expense", 500);
  }
});

export default router;
