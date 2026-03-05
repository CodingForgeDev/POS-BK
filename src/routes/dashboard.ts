import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import Inventory from "../models/Inventory";
import Expense from "../models/Expense";
import Attendance from "../models/Attendance";
import Customer from "../models/Customer";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const todayFilter = { createdAt: { $gte: todayStart, $lte: todayEnd } };

    const [
      todayInvoices,
      pendingOrders,
      completedOrders,
      lowStockItems,
      todayExpenses,
      presentToday,
      totalCustomers,
      recentOrders,
      topProducts,
      weeklyRevenue,
    ] = await Promise.all([
      Invoice.find(todayFilter).lean(),
      Order.countDocuments({ status: { $in: ["open", "accepted", "preparing"] } }),
      Order.countDocuments({ status: "completed", ...todayFilter }),
      Inventory.countDocuments({
        isActive: true,
        $expr: { $lte: ["$currentStock", "$minimumStock"] },
      }),
      Expense.aggregate([
        { $match: { date: { $gte: todayStart, $lte: todayEnd } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Attendance.countDocuments({
        date: { $gte: todayStart, $lte: todayEnd },
        status: "present",
      }),
      Customer.countDocuments({ isActive: true }),
      Order.find(todayFilter)
        .populate("customer", "name")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Invoice.aggregate([
        { $match: todayFilter },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.name",
            totalQty: { $sum: "$items.quantity" },
            totalRevenue: { $sum: "$items.subtotal" },
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 5 },
      ]),
      Invoice.aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const totalRevenue = (todayInvoices as any[]).reduce((sum, inv) => sum + inv.total, 0);
    const totalTax = (todayInvoices as any[]).reduce((sum, inv) => sum + inv.taxAmount, 0);
    const totalDiscount = (todayInvoices as any[]).reduce((sum, inv) => sum + inv.discountAmount, 0);
    const todayExpenseTotal = (todayExpenses as any[])[0]?.total || 0;
    const netProfit = totalRevenue - totalTax - todayExpenseTotal;

    const paymentBreakdown = (todayInvoices as any[]).reduce((acc: any, inv) => {
      acc[inv.paymentMethod] = (acc[inv.paymentMethod] || 0) + inv.total;
      return acc;
    }, {});

    return sendSuccess(res, {
      stats: {
        totalRevenue,
        totalTax,
        totalDiscount,
        todayExpenseTotal,
        netProfit,
        pendingOrders,
        completedOrders,
        lowStockItems,
        presentToday,
        totalCustomers,
        invoiceCount: (todayInvoices as any[]).length,
      },
      recentOrders,
      topProducts,
      weeklyRevenue,
      paymentBreakdown,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return sendError(res, "Failed to load dashboard data", 500);
  }
});

export default router;
