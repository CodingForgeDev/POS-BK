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

const router: Router = Router();

const parseDateParam = (value?: string, isStart = true) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (isStart) {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setHours(23, 59, 59, 999);
  }
  return date;
};

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const rangeStart = parseDateParam(req.query.from as string, true) ?? todayStart;
    const rangeEnd = parseDateParam(req.query.to as string, false) ?? todayEnd;
    const rangeFilter = { createdAt: { $gte: rangeStart, $lte: rangeEnd } };

    const [
      rangeInvoices,
      pendingOrders,
      completedOrders,
      lowStockItems,
      rangeExpenses,
      presentToday,
      totalCustomers,
      recentOrders,
      topProducts,
      weeklyRevenue,
    ] = await Promise.all([
      Invoice.find(rangeFilter).lean(),
      Order.countDocuments({ status: { $in: ["open", "accepted", "preparing"] }, ...rangeFilter }),
      Order.countDocuments({ status: "completed", ...rangeFilter }),
      Inventory.countDocuments({
        isActive: true,
        $expr: { $lte: ["$currentStock", "$minimumStock"] },
      }),
      Expense.aggregate([
        { $match: { date: { $gte: rangeStart, $lte: rangeEnd } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Attendance.countDocuments({
        date: { $gte: rangeStart, $lte: rangeEnd },
        status: "present",
      }),
      Customer.countDocuments({ isActive: true }),
      Order.find(rangeFilter)
        .populate("customer", "name")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Invoice.aggregate([
        { $match: rangeFilter },
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
        { $match: rangeFilter },
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

    const totalRevenue = (rangeInvoices as any[]).reduce((sum, inv) => sum + inv.total, 0);
    const totalTax = (rangeInvoices as any[]).reduce((sum, inv) => sum + inv.taxAmount, 0);
    const totalDiscount = (rangeInvoices as any[]).reduce((sum, inv) => sum + inv.discountAmount, 0);
    const rangeExpenseTotal = (rangeExpenses as any[])[0]?.total || 0;
    const netProfit = totalRevenue - totalTax - rangeExpenseTotal;

    const paymentBreakdown = (rangeInvoices as any[]).reduce((acc: any, inv) => {
      acc[inv.paymentMethod] = (acc[inv.paymentMethod] || 0) + inv.total;
      return acc;
    }, {});

    return sendSuccess(res, {
      stats: {
        totalRevenue,
        totalTax,
        totalDiscount,
        todayExpenseTotal: rangeExpenseTotal,
        netProfit,
        pendingOrders,
        completedOrders,
        lowStockItems,
        presentToday,
        totalCustomers,
        invoiceCount: (rangeInvoices as any[]).length,
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
