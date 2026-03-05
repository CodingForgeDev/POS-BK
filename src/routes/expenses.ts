import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Expense from "../models/Expense";

const router = Router();

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
      .sort({ date: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const summary = await Expense.aggregate([
      { $match: query },
      { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);

    const grandTotal = summary.reduce((sum, s) => sum + s.total, 0);

    return sendSuccess(res, { expenses, total, summary, grandTotal, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("Get expenses error:", error);
    return sendError(res, "Failed to fetch expenses", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const expense = await Expense.create({ ...req.body, addedBy: req.user.id });
    return sendSuccess(res, expense, "Expense added successfully", 201);
  } catch (error) {
    return sendError(res, "Failed to add expense", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
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
