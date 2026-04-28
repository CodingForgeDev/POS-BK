import { Router, Response } from "express";
import mongoose from "mongoose";
import { connectDB } from "../lib/mongodb";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { sendSuccess, sendError } from "../lib/utils";
import LedgerAccount from "../models/LedgerAccount";
import JournalEntry from "../models/JournalEntry";
import ReturnTransaction from "../models/ReturnTransaction";
import Purchase from "../models/Purchase";
import StockLayer from "../models/StockLayer";
import { deductInventoryFifo } from "../lib/inventoryFifo";
import { InsufficientStockError } from "../lib/inventoryErrors";
import { createJournalEntryRecord, createReturnJournalEntry, normalizeJournalLines, validateJournalBalance, reverseJournalEntryRecord } from "../lib/journalPosting";

async function applyPurchaseReturnInventoryDeduction(returnRecord: any, session: mongoose.ClientSession | null = null) {
  if (!returnRecord || String(returnRecord.returnType).trim().toLowerCase() !== "purchase") {
    return;
  }

  const purchaseId = returnRecord.purchaseId ? String(returnRecord.purchaseId) : null;
  let purchaseSupplier: mongoose.Types.ObjectId | null = null;

  if (purchaseId) {
    const purchase = (await Purchase.findById(purchaseId).lean()) as any;
    if (purchase && purchase.supplier) {
      purchaseSupplier = new mongoose.Types.ObjectId(String(purchase.supplier));
    }
  }

  for (const item of returnRecord.items || []) {
    if (!item || !item.inventoryItemId || Number(item.quantity) <= 0) continue;

    await deductInventoryFifo({
      inventoryItemId: String(item.inventoryItemId),
      quantity: Number(item.quantity),
      session,
      releaseReserved: 0,
      preferredPurchaseIds: purchaseId ? [purchaseId] : undefined,
    });

    const adjustmentLayer: any = {
      sourceType: "adjustment",
      purchase: purchaseId ? new mongoose.Types.ObjectId(purchaseId) : null,
      lineIndex: 0,
      inventoryItem: new mongoose.Types.ObjectId(String(item.inventoryItemId)),
      supplier: purchaseSupplier,
      createdBy: returnRecord.createdBy || null,
      adjustmentType: "remove",
      receivedAt: new Date(),
      quantityOriginal: Number(item.quantity),
      quantityRemaining: 0,
      unitCost: Number(item.unitPrice) || 0,
    };

    const layerOptions = session ? { session } : undefined;
    await StockLayer.create([adjustmentLayer], layerOptions);
  }
}

const router: Router = Router();

router.get("/accounts", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type, search } = req.query as Record<string, string>;
    const query: any = { isActive: true };
    if (type) query.type = String(type).trim();
    if (search) {
      const text = String(search).trim();
      query.$or = [
        { code: { $regex: text, $options: "i" } },
        { title: { $regex: text, $options: "i" } },
      ];
    }
    const accounts = await LedgerAccount.find(query).sort({ code: 1 }).lean();
    return sendSuccess(res, accounts);
  } catch (error) {
    console.error("Accounting accounts error:", error);
    return sendError(res, "Failed to fetch accounts", 500);
  }
});

router.get("/accounts/:id/ledger", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query as Record<string, string>;

    const account = (await LedgerAccount.findById(String(id)).lean()) as any;
    if (!account || !account.isActive) {
      return sendError(res, "Ledger account not found", 404);
    }

    const match: any = { "lines.account": account._id as any };
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        match.date = { ...match.date, $gte: fromDate };
      }
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!Number.isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        match.date = { ...match.date, $lte: toDate };
      }
    }

    const entries = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      { $match: { "lines.account": account._id as any } },
      { $sort: { date: 1, _id: 1 } },
      {
        $project: {
          _id: 0,
          date: 1,
          reference: 1,
          description: 1,
          debit: "$lines.debit",
          credit: "$lines.credit",
        },
      },
    ]);

    const totals = entries.reduce(
      (acc, row) => {
        acc.debit += Number(row.debit || 0);
        acc.credit += Number(row.credit || 0);
        return acc;
      },
      { debit: 0, credit: 0 }
    );

    return sendSuccess(res, {
      account,
      entries,
      totals,
    });
  } catch (error) {
    console.error("Accounting account ledger error:", error);
    return sendError(res, "Failed to fetch account ledger", 500);
  }
});

router.post("/accounts", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { code, title, type, address, contact, openingBalance } = req.body as Record<string, unknown>;
    if (!code || !title || !type) {
      return sendError(res, "Code, title, and account type are required", 400);
    }
    const account = await LedgerAccount.create({
      code: String(code).trim(),
      title: String(title).trim(),
      type: String(type).trim(),
      address: String(address || "").trim(),
      contact: String(contact || "").trim(),
      openingBalance: Number(openingBalance || 0),
      currentBalance: Number(openingBalance || 0),
    });
    return sendSuccess(res, account, "Account created", 201);
  } catch (error) {
    console.error("Accounting create account error:", error);
    return sendError(res, "Failed to create account", 500);
  }
});

router.patch("/accounts/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { code, title, type, address, contact, openingBalance } = req.body as Record<string, unknown>;
    if (!code || !title || !type) {
      return sendError(res, "Code, title, and account type are required", 400);
    }

    const account = await LedgerAccount.findById(String(id));
    if (!account) {
      return sendError(res, "Account not found", 404);
    }

    account.code = String(code).trim();
    account.title = String(title).trim();
    account.type = String(type).trim();
    account.address = String(address || "").trim();
    account.contact = String(contact || "").trim();

    const newOpeningBalance = Number(openingBalance || 0);
    if (!Number.isNaN(newOpeningBalance)) {
      if (account.currentBalance === account.openingBalance) {
        account.currentBalance = newOpeningBalance;
      }
      account.openingBalance = newOpeningBalance;
    }

    await account.save();
    return sendSuccess(res, account.toObject(), "Account updated");
  } catch (error) {
    console.error("Accounting update account error:", error);
    return sendError(res, "Failed to update account", 500);
  }
});

router.delete("/accounts/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const account = await LedgerAccount.findById(String(id));
    if (!account) {
      return sendError(res, "Account not found", 404);
    }
    account.isActive = false;
    await account.save();
    return sendSuccess(res, null, "Account deleted");
  } catch (error) {
    console.error("Accounting delete account error:", error);
    return sendError(res, "Failed to delete account", 500);
  }
});

router.get("/journal", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    const query: any = {};
    if (dateFrom) query.date = { $gte: new Date(dateFrom) };
    if (dateTo) query.date = { ...(query.date || {}), $lte: new Date(dateTo) };
    const entries = await JournalEntry.find(query).sort({ date: -1 }).lean();
    return sendSuccess(res, entries);
  } catch (error) {
    console.error("Accounting journal list error:", error);
    return sendError(res, "Failed to fetch journal entries", 500);
  }
});

router.post("/journal", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const status = String(req.body.status || "posted");
    const payload = {
      ...req.body,
      source: req.body.source || "MANUAL",
      sourceId: req.body.sourceId || null,
      status,
      postedBy: status === "posted" ? req.user.id : null,
    };
    const entry = await createJournalEntryRecord(payload);
    return sendSuccess(res, entry, "Journal posted", 201);
  } catch (error: any) {
    console.error("Accounting create journal error:", error);
    const message = error?.message || "Failed to save journal entry";
    const status = message === "Journal entry already exists for this source" ? 409 : message.includes("required") ? 400 : 500;
    return sendError(res, message, status);
  }
});

router.get("/trial-balance", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    const accountQuery: any = { isActive: true };
    const journalMatch: any = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!Number.isNaN(from.getTime())) journalMatch.date = { ...journalMatch.date, $gte: from };
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        journalMatch.date = { ...journalMatch.date, $lte: to };
      }
    }

    const accounts = await LedgerAccount.find(accountQuery).sort({ code: 1 }).lean();
    const aggregationPipeline: any[] = [];
    if (Object.keys(journalMatch).length) {
      aggregationPipeline.push({ $match: journalMatch });
    }
    aggregationPipeline.push(
      { $unwind: "$lines" },
      {
        $group: {
          _id: "$lines.account",
          totalDebit: { $sum: "$lines.debit" },
          totalCredit: { $sum: "$lines.credit" },
        },
      },
      {
        $lookup: {
          from: LedgerAccount.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: "$account" },
      {
        $project: {
          accountId: { $toString: "$_id" },
          code: "$account.code",
          title: "$account.title",
          type: "$account.type",
          openingBalance: "$account.openingBalance",
          currentBalance: "$account.currentBalance",
          debitTotal: "$totalDebit",
          creditTotal: "$totalCredit",
        },
      }
    );

    const aggregatedRows = await JournalEntry.aggregate(aggregationPipeline);
    const totalsByAccount = new Map<string, { debit: number; credit: number }>();
    for (const row of aggregatedRows) {
      totalsByAccount.set(String(row.accountId), {
        debit: Number(row.debitTotal || 0),
        credit: Number(row.creditTotal || 0),
      });
    }

    const rows = accounts.map((account) => {
      const totals = totalsByAccount.get(String(account._id)) || { debit: 0, credit: 0 };
      return {
        accountId: String(account._id),
        code: account.code,
        title: account.title,
        type: account.type,
        openingBalance: Number(account.openingBalance || 0),
        currentBalance: Number(account.currentBalance || 0),
        debitTotal: totals.debit,
        creditTotal: totals.credit,
      };
    });

    const totalDebit = rows.reduce((sum, row) => sum + row.debitTotal, 0);
    const totalCredit = rows.reduce((sum, row) => sum + row.creditTotal, 0);

    return sendSuccess(res, { rows, totalDebit, totalCredit });
  } catch (error) {
    console.error("Accounting trial balance error:", error);
    return sendError(res, "Failed to fetch trial balance", 500);
  }
});

router.get("/balance-sheet", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    const accountQuery: any = {
      isActive: true,
      type: { $in: ["asset", "bank", "receivable"] },
    };

    const journalMatch: any = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!Number.isNaN(from.getTime())) journalMatch.date = { ...journalMatch.date, $gte: from };
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        journalMatch.date = { ...journalMatch.date, $lte: to };
      }
    }

    const accounts = await LedgerAccount.find(accountQuery).sort({ code: 1 }).lean();
    const accountIds = accounts.map((account) => account._id);

    const aggregationPipeline: any[] = [];
    if (Object.keys(journalMatch).length) {
      aggregationPipeline.push({ $match: journalMatch });
    }
    aggregationPipeline.push(
      { $unwind: "$lines" },
      { $match: { "lines.account": { $in: accountIds } } },
      {
        $group: {
          _id: "$lines.account",
          totalDebit: { $sum: "$lines.debit" },
          totalCredit: { $sum: "$lines.credit" },
        },
      },
      {
        $lookup: {
          from: LedgerAccount.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: "$account" },
      {
        $project: {
          accountId: { $toString: "$_id" },
          code: "$account.code",
          title: "$account.title",
          type: "$account.type",
          openingBalance: "$account.openingBalance",
          currentBalance: "$account.currentBalance",
          debitTotal: "$totalDebit",
          creditTotal: "$totalCredit",
        },
      }
    );

    const aggregatedRows = await JournalEntry.aggregate(aggregationPipeline);
    const totalsByAccount = new Map<string, { debit: number; credit: number }>();
    for (const row of aggregatedRows) {
      totalsByAccount.set(String(row.accountId), {
        debit: Number(row.debitTotal || 0),
        credit: Number(row.creditTotal || 0),
      });
    }

    const rows = accounts.map((account) => {
      const totals = totalsByAccount.get(String(account._id)) || { debit: 0, credit: 0 };
      const balance = Number(account.openingBalance || 0) + totals.debit - totals.credit;
      return {
        accountId: String(account._id),
        code: account.code,
        title: account.title,
        type: account.type,
        openingBalance: Number(account.openingBalance || 0),
        debitTotal: totals.debit,
        creditTotal: totals.credit,
        balance,
      };
    });

    const totalAssets = rows.reduce((sum, row) => sum + row.balance, 0);
    return sendSuccess(res, { rows, totalAssets });
  } catch (error) {
    console.error("Accounting balance sheet error:", error);
    return sendError(res, "Failed to fetch balance sheet", 500);
  }
});

router.get("/balance-sheet", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    const accountQuery: any = {
      isActive: true,
      type: { $in: ["asset", "bank", "receivable"] },
    };

    const journalMatch: any = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!Number.isNaN(from.getTime())) journalMatch.date = { ...journalMatch.date, $gte: from };
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        journalMatch.date = { ...journalMatch.date, $lte: to };
      }
    }

    const accounts = await LedgerAccount.find(accountQuery).sort({ code: 1 }).lean();
    const accountIds = accounts.map((account) => account._id);

    const aggregationPipeline: any[] = [];
    if (Object.keys(journalMatch).length) {
      aggregationPipeline.push({ $match: journalMatch });
    }
    aggregationPipeline.push(
      { $unwind: "$lines" },
      { $match: { "lines.account": { $in: accountIds } } },
      {
        $group: {
          _id: "$lines.account",
          totalDebit: { $sum: "$lines.debit" },
          totalCredit: { $sum: "$lines.credit" },
        },
      },
      {
        $lookup: {
          from: LedgerAccount.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: "$account" },
      {
        $project: {
          accountId: { $toString: "$_id" },
          code: "$account.code",
          title: "$account.title",
          type: "$account.type",
          openingBalance: "$account.openingBalance",
          currentBalance: "$account.currentBalance",
          debitTotal: "$totalDebit",
          creditTotal: "$totalCredit",
        },
      }
    );

    const aggregatedRows = await JournalEntry.aggregate(aggregationPipeline);
    const totalsByAccount = new Map<string, { debit: number; credit: number }>();
    for (const row of aggregatedRows) {
      totalsByAccount.set(String(row.accountId), {
        debit: Number(row.debitTotal || 0),
        credit: Number(row.creditTotal || 0),
      });
    }

    const rows = accounts.map((account) => {
      const totals = totalsByAccount.get(String(account._id)) || { debit: 0, credit: 0 };
      const balance = Number(account.openingBalance || 0) + totals.debit - totals.credit;
      return {
        accountId: String(account._id),
        code: account.code,
        title: account.title,
        type: account.type,
        openingBalance: Number(account.openingBalance || 0),
        debitTotal: totals.debit,
        creditTotal: totals.credit,
        balance,
      };
    });

    const totalAssets = rows.reduce((sum, row) => sum + row.balance, 0);
    return sendSuccess(res, { rows, totalAssets });
  } catch (error) {
    console.error("Accounting balance sheet error:", error);
    return sendError(res, "Failed to fetch balance sheet", 500);
  }
});

router.patch("/journal/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { date, reference, description, lines, source, sourceId, status } = req.body as Record<string, unknown>;
    if (!date || !Array.isArray(lines) || lines.length === 0) {
      return sendError(res, "Date and at least one journal line are required", 400);
    }

    const entry = await JournalEntry.findById(String(id));
    if (!entry) {
      return sendError(res, "Journal entry not found", 404);
    }

    const normalizedLines = normalizeJournalLines(lines as any[]);
    if (normalizedLines.length < 2) {
      return sendError(res, "At least two valid journal lines are required", 400);
    }

    const invalidLine = (lines as any[]).find((line) => {
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);
      return line.account && line.accountName && ((debit > 0 && credit > 0) || (debit === 0 && credit === 0));
    });
    if (invalidLine) {
      return sendError(res, "Each journal line must have exactly one nonzero amount on debit or credit", 400);
    }

    const { totalDebit, totalCredit, balanced } = validateJournalBalance(normalizedLines);
    if (!balanced) {
      return sendError(res, "Journal entry must balance debit and credit", 400);
    }

    const accountIds = normalizedLines.map((line) => String(line.account));
    const existingAccounts = await LedgerAccount.find({ _id: { $in: accountIds } }).lean();
    const accountMap = Object.fromEntries(existingAccounts.map((acct) => [String(acct._id), acct]));

    const invalidAccount = normalizedLines.find((line) => !accountMap[String(line.account)]);
    if (invalidAccount) {
      return sendError(res, `Ledger account not found for line: ${invalidAccount.accountName || String(invalidAccount.account)}` , 400);
    }

    if (source && source !== entry.source && sourceId) {
      const duplicate = await JournalEntry.findOne({ source, sourceId, _id: { $ne: entry._id } });
      if (duplicate) {
        return sendError(res, "Journal entry already exists for this source", 409);
      }
    }

    const preparedLines = normalizedLines.map((line) => ({
      account: line.account,
      accountName: accountMap[String(line.account)]?.title || line.accountName,
      debit: line.debit,
      credit: line.credit,
      note: line.note,
    }));

    entry.date = new Date(String(date));
    entry.reference = String(reference || "").trim();
    entry.description = String(description || "").trim();
    entry.lines = preparedLines;
    entry.totalDebit = totalDebit;
    entry.totalCredit = totalCredit;
    if (source) entry.source = String(source);
    if (sourceId) entry.sourceId = sourceId as any;
    if (status) {
      entry.status = String(status);
      if (entry.status === "posted" && !entry.postedBy) {
        entry.postedBy = req.user.id;
      }
    }

    await entry.save();
    return sendSuccess(res, entry.toObject(), "Journal entry updated");
  } catch (error) {
    console.error("Accounting update journal error:", error);
    return sendError(res, "Failed to update journal entry", 500);
  }
});

router.delete("/journal/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const entry = await JournalEntry.findById(String(id));
    if (!entry) {
      return sendError(res, "Journal entry not found", 404);
    }
    await entry.deleteOne();
    return sendSuccess(res, null, "Journal entry deleted");
  } catch (error) {
    console.error("Accounting delete journal error:", error);
    return sendError(res, "Failed to delete journal entry", 500);
  }
});

router.post("/journal/:id/reverse", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const entry = await JournalEntry.findById(String(id));
    if (!entry) {
      return sendError(res, "Journal entry not found", 404);
    }

    const reversed = await reverseJournalEntryRecord(entry, {
      ...req.body,
      postedBy: req.user.id,
      status: String(req.body.status || "posted"),
    });

    return sendSuccess(res, reversed, "Journal entry reversed", 201);
  } catch (error: any) {
    console.error("Accounting reverse journal error:", error);
    const message = error?.message || "Failed to reverse journal entry";
    const status = message === "Journal entry already exists for this source" ? 409 : message.includes("required") ? 400 : 500;
    return sendError(res, message, status);
  }
});

router.get("/returns", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type, dateFrom, dateTo } = req.query as Record<string, string>;
    const query: any = {};
    if (type) query.returnType = type;
    if (dateFrom) query.date = { $gte: new Date(dateFrom) };
    if (dateTo) query.date = { ...(query.date || {}), $lte: new Date(dateTo) };
    const returns = await ReturnTransaction.find(query).sort({ date: -1 }).lean();
    return sendSuccess(res, returns);
  } catch (error) {
    console.error("Accounting returns list error:", error);
    return sendError(res, "Failed to fetch returns", 500);
  }
});

router.post("/returns", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { returnType, date, reference, relatedInvoice, purchaseId, customerName, supplierName, reason, items, totalAmount } = req.body as Record<string, unknown>;
    if (!returnType || !date || !Array.isArray(items) || items.length === 0) {
      return sendError(res, "Return type, date and returned items are required", 400);
    }
    let selectedPurchase: any = null;
    if (purchaseId) {
      const purchaseValue = String(purchaseId);
      if (!mongoose.Types.ObjectId.isValid(purchaseValue)) {
        return sendError(res, "Selected purchase invoice is invalid", 400);
      }
      selectedPurchase = await Purchase.findById(purchaseValue).lean();
      if (!selectedPurchase) {
        return sendError(res, "Selected purchase invoice was not found", 404);
      }
    }
    const normalizedItems = (items as any[])
      .map((item) => {
        const productId = String(item.productId || item.inventoryItemId || "").trim();
        const inventoryItemId = String(item.inventoryItemId || "").trim();
        return {
          productId: mongoose.Types.ObjectId.isValid(productId) ? productId : undefined,
          inventoryItemId: mongoose.Types.ObjectId.isValid(inventoryItemId) ? inventoryItemId : undefined,
          name: String(item.name || "").trim(),
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unitPrice || 0),
          subtotal: Number(item.subtotal || 0),
          condition: String(item.condition || "").trim(),
          note: String(item.note || "").trim(),
        };
      })
      .filter((item) => item.name && item.quantity > 0);
    if (!normalizedItems.length) {
      return sendError(res, "At least one valid returned item is required", 400);
    }
    const parsedTotalAmount = Number(totalAmount || 0);
    if (parsedTotalAmount <= 0) {
      return sendError(res, "Total return amount must be greater than zero", 400);
    }
    let accountId: string | null = null;
    let accountName = "";
    if (req.body?.account) {
      const accountValue = String(req.body.account);
      if (!mongoose.Types.ObjectId.isValid(accountValue)) {
        return sendError(res, "Selected ledger account is invalid", 400);
      }
      const account = await LedgerAccount.findById(accountValue).lean<any>();
      if (!account) {
        return sendError(res, "Selected ledger account was not found", 400);
      }
      accountId = String(account._id);
      accountName = account.title;
    }

    const status = String(
      req.body.status ||
        (String(returnType).trim().toLowerCase() === "sale" ? "processed" : "pending")
    ).trim();
    if (!["pending", "processed", "rejected"].includes(status)) {
      return sendError(res, "Invalid return status", 400);
    }

    const session = await mongoose.startSession();
    let returnRecord: any = null;
    try {
      await session.withTransaction(async () => {
        const [created] = await ReturnTransaction.create([
          {
            returnType: String(returnType).trim(),
            date: new Date(String(date)),
            reference: String(reference || "").trim(),
            purchaseId: selectedPurchase ? selectedPurchase._id : null,
            relatedInvoice: String(relatedInvoice || "").trim(),
            customerName: String(customerName || "").trim(),
            supplierName: String(supplierName || "").trim(),
            account: accountId,
            accountName,
            reason: String(reason || "").trim(),
            items: normalizedItems,
            totalAmount: Number(totalAmount || 0),
            createdBy: req.user.id,
            status,
            creditType: String(req.body.creditType || "credit_note").trim(),
          },
        ], { session });

        returnRecord = created.toObject();
        if (status === "processed") {
          try {
            await applyPurchaseReturnInventoryDeduction(returnRecord, session);
          } catch (inventoryError: any) {
            throw inventoryError;
          }
          try {
            await createReturnJournalEntry(returnRecord, session);
          } catch (journalError: any) {
            console.warn(
              "Accounting create return: journal entry skipped due to journal entry error",
              journalError
            );
          }
        }
      });
    } catch (error: any) {
      const msg = error?.message || String(error);
      const isTransactionUnavailable = /replica set|Transaction numbers/i.test(msg);
      if (isTransactionUnavailable) {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        try {
          const created = await ReturnTransaction.create({
            returnType: String(returnType).trim(),
            date: new Date(String(date)),
            reference: String(reference || "").trim(),
            purchaseId: selectedPurchase ? selectedPurchase._id : null,
            relatedInvoice: String(relatedInvoice || "").trim(),
            customerName: String(customerName || "").trim(),
            supplierName: String(supplierName || "").trim(),
            account: accountId,
            accountName,
            reason: String(reason || "").trim(),
            creditType: String(req.body.creditType || "credit_note").trim(),
            items: normalizedItems,
            totalAmount: Number(totalAmount || 0),
            createdBy: req.user.id,
            status,
          });
          returnRecord = created.toObject();
          if (status === "processed") {
            try {
              await applyPurchaseReturnInventoryDeduction(returnRecord, null);
            } catch (inventoryError: any) {
              console.error("Accounting create return fallback inventory deduction failed:", inventoryError);
              if (inventoryError instanceof InsufficientStockError) {
                return sendError(res, inventoryError.message, 409, { shortages: inventoryError.shortages });
              }
              return sendError(res, inventoryError?.message || "Failed to apply inventory deduction", 500);
            }
            try {
              await createReturnJournalEntry(returnRecord);
            } catch (innerError: any) {
              console.warn(
                "Accounting create return fallback: journal entry skipped due to journal entry error",
                innerError
              );
            }
          }
        } catch (innerError: any) {
          console.error("Accounting create return fallback error:", innerError);
          return sendError(res, innerError?.message || "Failed to save return", 500);
        }
      } else {
        console.error("Accounting create return error:", error);
        return sendError(res, msg || "Failed to save return", 500);
      }
    } finally {
      session.endSession();
    }

    return sendSuccess(res, returnRecord, "Return recorded", 201);
  } catch (error: any) {
    console.error("Accounting create return error:", error);
    return sendError(res, error?.message || "Failed to save return", 500);
  }
});

router.patch("/returns/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const returnId = String(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(returnId)) {
      return sendError(res, "Invalid return id", 400);
    }

    const returnDoc = await ReturnTransaction.findById(returnId);
    if (!returnDoc) {
      return sendError(res, "Return not found", 404);
    }

    const { status, account, creditType, supplierName, reason, reference, relatedInvoice } = req.body as Record<string, unknown>;
    const nextStatus = String(status || returnDoc.status).trim();
    if (!["pending", "processed", "rejected"].includes(nextStatus)) {
      return sendError(res, "Invalid return status", 400);
    }

    if (account) {
      const accountValue = String(account);
      if (!mongoose.Types.ObjectId.isValid(accountValue)) {
        return sendError(res, "Selected ledger account is invalid", 400);
      }
      const accountRecord = await LedgerAccount.findById(accountValue).lean<any>();
      if (!accountRecord) {
        return sendError(res, "Selected ledger account was not found", 400);
      }
      returnDoc.account = accountValue;
      returnDoc.accountName = accountRecord.title;
    }

    if (supplierName !== undefined) {
      returnDoc.supplierName = String(supplierName || "").trim();
    }
    if (reason !== undefined) {
      returnDoc.reason = String(reason || "").trim();
    }
    if (reference !== undefined) {
      returnDoc.reference = String(reference || "").trim();
    }
    if (relatedInvoice !== undefined) {
      returnDoc.relatedInvoice = String(relatedInvoice || "").trim();
    }
    if (creditType !== undefined) {
      returnDoc.creditType = String(creditType || "credit_note").trim();
    }

    if (returnDoc.status !== "processed" && nextStatus === "processed") {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await applyPurchaseReturnInventoryDeduction(returnDoc.toObject(), session);
          try {
            await createReturnJournalEntry(returnDoc.toObject(), session);
          } catch (journalError: any) {
            console.warn(
              "Accounting approve return: journal entry skipped due to journal error",
              journalError
            );
          }
          returnDoc.status = nextStatus;
          await returnDoc.save({ session });
        });
      } catch (approvalError: any) {
        const message = approvalError?.message || String(approvalError);
        const isTransactionUnavailable = /replica set|Transaction numbers/i.test(message);
        if (isTransactionUnavailable) {
          if (session.inTransaction()) {
            await session.abortTransaction();
          }
          try {
            await applyPurchaseReturnInventoryDeduction(returnDoc.toObject(), null);
          } catch (inventoryError: any) {
            console.error("Accounting approve return fallback inventory deduction failed:", inventoryError);
            if (inventoryError instanceof InsufficientStockError) {
              return sendError(res, inventoryError.message, 409, { shortages: inventoryError.shortages });
            }
            return sendError(res, inventoryError?.message || "Failed to approve return", 500);
          }
          try {
            await createReturnJournalEntry(returnDoc.toObject());
          } catch (journalError: any) {
            console.warn(
              "Accounting approve return fallback: journal entry skipped due to journal error",
              journalError
            );
          }
          returnDoc.status = nextStatus;
          await returnDoc.save();
        } else {
          console.error("Accounting approve return failed to process inventory and journal entry:", approvalError);
          if (approvalError instanceof InsufficientStockError) {
            return sendError(res, approvalError.message, 409, { shortages: approvalError.shortages });
          }
          return sendError(res, approvalError?.message || "Failed to approve return", 500);
        }
      } finally {
        session.endSession();
      }
    } else {
      returnDoc.status = nextStatus;
      await returnDoc.save();
    }

    return sendSuccess(res, returnDoc.toObject(), "Return updated");
  } catch (error: any) {
    console.error("Accounting update return error:", error);
    return sendError(res, error?.message || "Failed to update return", 500);
  }
});

export default router;
