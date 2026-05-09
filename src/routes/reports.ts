import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import Expense from "../models/Expense";
import User from "../models/User";
import BOMTransaction from "../models/bom-transaction.model";

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

router.get("/staff-performance", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type = "daily", date = new Date().toISOString().split("T")[0] } = req.query as Record<string, string>;

    let startDate: Date;
    let endDate: Date;
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
      endDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const dateFilter = { createdAt: { $gte: startDate, $lte: endDate } };

    const [waiterStats, cashierStats] = await Promise.all([
      Order.aggregate([
        { $match: { ...dateFilter, status: "completed", servedBy: { $exists: true, $ne: null } } },
        {
          $project: {
            servedBy: 1,
            total: 1,
            itemsQty: {
              $sum: {
                $map: {
                  input: "$items",
                  as: "item",
                  in: { $ifNull: ["$$item.quantity", 0] },
                },
              },
            },
          },
        },
        {
          $group: {
            _id: "$servedBy",
            total_orders: { $sum: 1 },
            total_items: { $sum: "$itemsQty" },
            total_revenue: { $sum: "$total" },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
          },
        },
        {
          $unwind: {
            path: "$user",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            staff_id: "$_id",
            staff_name: { $ifNull: ["$user.name", "Unknown"] },
            total_orders: 1,
            total_items: 1,
            total_revenue: 1,
          },
        },
        { $sort: { total_orders: -1, total_revenue: -1 } },
      ]),
      Invoice.aggregate([
        { $match: { ...dateFilter, issuedBy: { $exists: true, $ne: null } } },
        {
          $group: {
            _id: "$issuedBy",
            total_transactions: { $sum: 1 },
            total_collected: { $sum: "$total" },
            total_discounts: { $sum: "$discountAmount" },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
          },
        },
        {
          $unwind: {
            path: "$user",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            staff_id: "$_id",
            staff_name: { $ifNull: ["$user.name", "Unknown"] },
            total_transactions: 1,
            total_collected: 1,
            total_discounts: 1,
          },
        },
        { $sort: { total_transactions: -1, total_collected: -1 } },
      ]),
    ]);

    return sendSuccess(res, { waiterStats, cashierStats });
  } catch (error) {
    console.error("Staff performance error:", error);
    return sendError(res, "Failed to fetch staff performance", 500);
  }
});

router.get("/manufacturing", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { from, to, status, station } = req.query as Record<string, string>;

    // Parse date range
    let startDate: Date;
    let endDate: Date;

    if (from) {
      startDate = new Date(from);
      startDate.setHours(0, 0, 0, 0);
    } else {
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 1);
      startDate.setHours(0, 0, 0, 0);
    }

    if (to) {
      endDate = new Date(to);
      endDate.setHours(23, 59, 59, 999);
    } else {
      endDate = new Date();
      endDate.setHours(23, 59, 59, 999);
    }

    // Build filter
    const filter: any = {
      date: { $gte: startDate, $lte: endDate },
    };

    if (status && status !== "all") {
      filter.status = status;
    }

    // Fetch BOM transactions
    const boms = await BOMTransaction.find(filter as any)
      .populate("createdBy", "name email")
      .lean();

    // Format report rows
    const reportRows = (boms as any[]).map((bom) => {
      const profitMargin =
        bom.totalProducedValue > 0
          ? (((bom.totalProducedValue - bom.totalRawCost) / bom.totalProducedValue) * 100).toFixed(2)
          : "0.00";

      return {
        _id: bom._id,
        transactionNo: bom.transactionNo,
        date: bom.date.toISOString().split("T")[0],
        status: bom.status,
        totalRawCost: bom.totalRawCost,
        totalProducedQty: bom.totalProducedQty,
        totalProducedValue: bom.totalProducedValue,
        profitMargin: Number(profitMargin),
        variance: bom.variance,
        createdBy: (bom.createdBy as any)?._id || "",
        createdByName: (bom.createdBy as any)?.name || "Unknown",
        rawMaterialsCount: bom.rawMaterials?.length || 0,
        producedItemsCount: (bom.producedItems?.length || 0) + (bom.producedMenuItems?.length || 0),
        journalEntryId: bom.journalEntryId,
      };
    });

    // Calculate summary
    const summary = {
      totalRawCost: reportRows.reduce((sum, r) => sum + r.totalRawCost, 0),
      totalProducedQty: reportRows.reduce((sum, r) => sum + r.totalProducedQty, 0),
      totalProducedValue: reportRows.reduce((sum, r) => sum + r.totalProducedValue, 0),
      totalProfit: reportRows.reduce((sum, r) => sum + (r.totalProducedValue - r.totalRawCost), 0),
      totalMargin: 0,
      postedCount: reportRows.filter((r) => r.status === "posted").length,
      reversedCount: reportRows.filter((r) => r.status === "reversed").length,
      draftCount: reportRows.filter((r) => r.status === "draft").length,
    };

    summary.totalMargin =
      summary.totalProducedValue > 0
        ? (((summary.totalProfit) / summary.totalProducedValue) * 100)
        : 0;

    return sendSuccess(res, {
      data: reportRows,
      summary,
    });
  } catch (error) {
    console.error("Manufacturing report error:", error);
    return sendError(res, "Failed to fetch manufacturing report", 500);
  }
});

export default router;
