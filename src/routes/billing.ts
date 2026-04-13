import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError, generateInvoiceNumber } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import Customer from "../models/Customer";
import { getGstRateForMethod } from "../lib/gst";
import {
  executeBillingWithRecipeConsumption,
  InsufficientStockError,
} from "../lib/recipeInventory";

function invoiceTotalsFromOrder(order: any, gstRatePct: number) {
  const discountAmount = order.discountAmount || 0;
  const afterDiscount = Math.max(0, order.subtotal - discountAmount);
  const serviceChargeAmount = Number(order.serviceChargeAmount) || 0;
  const taxableBase = afterDiscount + serviceChargeAmount;
  const rate = Math.max(0, Math.min(100, gstRatePct));
  const taxAmount = (taxableBase * rate) / 100;
  const total = taxableBase + taxAmount;
  return { discountAmount, serviceChargeAmount, taxAmount, total };
}

const router: Router = Router();

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

    const gstRatePct = await getGstRateForMethod(paymentMethod);
    const { discountAmount, serviceChargeAmount, taxAmount, total } = invoiceTotalsFromOrder(
      order,
      gstRatePct
    );

    let invoice;
    try {
      const result = await executeBillingWithRecipeConsumption({
        orderId,
        userId: req.user.id,
        paymentMethod,
        amountPaid,
        discountType,
        discountValue,
        notes,
        gstRatePct,
        invoiceNumber: generateInvoiceNumber(),
        discountAmount,
        serviceChargeAmount,
        taxAmount,
        total,
      });
      invoice = result.invoice;
    } catch (e: unknown) {
      if (e instanceof InsufficientStockError) {
        return sendError(res, e.message, 409, { code: e.code, shortages: e.shortages });
      }
      if (e instanceof Error && e.message.includes("MongoDB transactions require")) {
        return sendError(res, e.message, 503);
      }
      if (e instanceof Error && e.message === "ORDER_NOT_FOUND") {
        return sendError(res, "Order not found", 404);
      }
      if (e instanceof Error && e.message === "ORDER_ALREADY_BILLED") {
        return sendError(res, "Order already billed", 400);
      }
      throw e;
    }

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
