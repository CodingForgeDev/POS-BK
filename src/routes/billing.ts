import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError, generateInvoiceNumber } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import Customer from "../models/Customer";
import { getGstRateForMethod } from "../lib/gst";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { page = "1", limit = "20", date, method } = req.query as Record<string, string>;

    const query: any = {};
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }
    if (method) query.paymentMethod = method;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate("order", "orderNumber type")
      .populate("customer", "name phone")
      .populate("issuedBy", "name")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return sendSuccess(res, { invoices, total, page: pageNum, limit: limitNum });
  } catch (error) {
    return sendError(res, "Failed to fetch invoices", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { orderId, paymentMethod, amountPaid, discountType, discountValue, notes } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return sendError(res, "Order not found", 404);
    if (order.status === "completed") return sendError(res, "Order already billed", 400);

    let discountAmount = 0;
    if (discountType && discountType !== "none" && discountValue > 0) {
      discountAmount =
        discountType === "percentage"
          ? (order.subtotal * discountValue) / 100
          : discountValue;
    }

    const gstRatePct = await getGstRateForMethod(paymentMethod);
    const taxAmount = order.subtotal * (gstRatePct / 100);
    const total = order.subtotal + taxAmount - discountAmount;
    const changeGiven = amountPaid - total;

    const invoice = await Invoice.create({
      invoiceNumber: generateInvoiceNumber(),
      order: orderId,
      customer: order.customer,
      customerName: order.customerName,
      items: order.items.map(({ name, quantity, price, subtotal }: any) => ({
        name,
        quantity,
        price,
        subtotal,
      })),
      subtotal: order.subtotal,
      taxRate: gstRatePct,
      taxAmount,
      discountType: discountType || "none",
      discountValue: discountValue || 0,
      discountAmount,
      total,
      paymentMethod,
      amountPaid,
      changeGiven: Math.max(0, changeGiven),
      notes: notes || "",
      issuedBy: req.user.id,
    });

    await Order.findByIdAndUpdate(orderId, {
      status: "completed",
      taxAmount,
      total,
    });

    if (order.customer) {
      await Customer.findByIdAndUpdate(order.customer, {
        $inc: { totalSpent: total, totalOrders: 1, loyaltyPoints: Math.floor(total) },
      });
    }

    const populated = await Invoice.findById(invoice._id)
      .populate("order", "orderNumber type")
      .populate("customer", "name phone");

    return sendSuccess(res, populated, "Invoice created successfully", 201);
  } catch (error) {
    console.error("Billing error:", error);
    return sendError(res, "Failed to create invoice", 500);
  }
});

export default router;
