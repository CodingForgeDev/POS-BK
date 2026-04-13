import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import Expense from "../models/Expense";

const router: Router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type = "daily", date = new Date().toISOString().split("T")[0] } = req.query as Record<string, string>;

    let startDate: Date, endDate: Date;
    const baseDate = new Date(date);

    if (type === "daily") {
      startDate = new Date(baseDate);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(baseDate);
      endDate.setHours(23, 59, 59, 999);
    } else if (type === "weekly") {
      const day = baseDate.getDay();
      startDate = new Date(baseDate);
      startDate.setDate(baseDate.getDate() - day);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
      endDate = new Date(
        baseDate.getFullYear(),
        baseDate.getMonth() + 1,
        0,
        23,
        59,
        59,
        999
      );
    }

    const dateFilter = { createdAt: { $gte: startDate, $lte: endDate } };
    const expenseDateFilter = { date: { $gte: startDate, $lte: endDate } };

    const [invoices, orderStats, topProducts, expensesByCategory, discountStats] = await Promise.all([
      Invoice.find(dateFilter).lean(),
      Order.aggregate([
        { $match: { ...dateFilter, status: "completed" } },
        { $group: { _id: "$type", count: { $sum: 1 }, revenue: { $sum: "$total" } } },
      ]),
      Invoice.aggregate([
        { $match: dateFilter },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.name",
            totalQty: { $sum: "$items.quantity" },
            totalRevenue: { $sum: "$items.subtotal" },
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 10 },
      ]),
      Expense.aggregate([
        { $match: expenseDateFilter },
        { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Invoice.aggregate([
        { $match: { ...dateFilter, discountAmount: { $gt: 0 } } },
        {
          $group: {
            _id: "$discountType",
            totalDiscount: { $sum: "$discountAmount" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const totalRevenue = (invoices as any[]).reduce((sum, inv) => sum + inv.total, 0);
    const totalTax = (invoices as any[]).reduce((sum, inv) => sum + inv.taxAmount, 0);
    const totalDiscount = (invoices as any[]).reduce((sum, inv) => sum + inv.discountAmount, 0);
    const totalOrders = invoices.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const totalExpenses = expensesByCategory.reduce((sum, e) => sum + e.total, 0);

    const grossProfit = totalRevenue - totalTax;
    const netProfit = grossProfit - totalExpenses;
    const profitMargin =
      totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : 0;

    const paymentBreakdown = (invoices as any[]).reduce((acc: any, inv) => {
      acc[inv.paymentMethod] = (acc[inv.paymentMethod] || 0) + inv.total;
      return acc;
    }, {});

    return sendSuccess(res, {
      period: { type, startDate, endDate },
      summary: {
        totalRevenue,
        totalTax,
        totalDiscount,
        totalOrders,
        avgOrderValue,
        totalExpenses,
        grossProfit,
        netProfit,
        profitMargin,
      },
      orderStats,
      paymentBreakdown,
      topProducts,
      expensesByCategory,
      discountStats,
    });
  } catch (error) {
    console.error("Reports error:", error);
    return sendError(res, "Failed to generate report", 500);
  }
});

export default router;
