import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError, generateInvoiceNumber } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import { isAdminRoleName } from "../lib/role-utils";
import Customer from "../models/Customer";
import { getGstRateForMethod } from "../lib/gst";
import {
  executeBillingWithRecipeConsumption,
  InsufficientStockError,
} from "../lib/recipeInventory";

function invoiceTotalsFromOrder(order: any, gstRatePct: number, paymentAccountDiscountAmount: number = 0) {
  const discountAmount = order.discountAmount || 0;
  const serviceChargeAmount = Number(order.serviceChargeAmount) || 0;
  const existingTaxAmount = Number(order.taxAmount) || 0;
  const existingTotal = Number(order.total) || 0;

  if (Number.isFinite(existingTotal) && existingTotal > 0) {
    const total = Math.max(0, existingTotal - Math.max(0, paymentAccountDiscountAmount));
    return { discountAmount, serviceChargeAmount, taxAmount: existingTaxAmount, total };
  }

  const afterDiscount = Math.max(0, order.subtotal - discountAmount);
  const taxableBase = Math.max(0, afterDiscount + serviceChargeAmount - Math.max(0, paymentAccountDiscountAmount));
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
    if (!(await isAdminRoleName(req.user.role))) {
      query.issuedBy = req.user.id;
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate("issuedBy", "name")
      .populate({
        path: "order",
        select: "orderNumber type tableNumber",
        populate: { path: "servedBy", select: "name" },
      })
      .populate("customer", "name phone")
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
    const {
      orderId,
      paymentMethod,
      amountPaid,
      discountType,
      discountValue,
      notes,
      paymentAccountName,
      paymentAccountDiscountType,
      paymentAccountDiscountValue,
      paymentAccountDiscountAmount,
    } = req.body;

    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      return sendError(res, "Order ID is required", 400);
    }

    const paymentMethodValue = String(paymentMethod ?? "").trim();
    if (!paymentMethodValue) {
      return sendError(res, "Payment method is required", 400);
    }

    const amountPaidValue = Number(amountPaid);
    if (!Number.isFinite(amountPaidValue) || amountPaidValue < 0) {
      return sendError(res, "Amount paid must be a valid non-negative number", 400);
    }

    const discountTypeValue = ["percentage", "fixed", "none"].includes(String(discountType ?? ""))
      ? String(discountType)
      : "none";
    const discountValueNumber = Number(discountValue ?? 0);
    const paymentAccountDiscountTypeValue = ["percentage", "fixed", "none"].includes(String(paymentAccountDiscountType ?? ""))
      ? String(paymentAccountDiscountType)
      : "none";
    const paymentAccountDiscountValueNumber = Number(paymentAccountDiscountValue ?? 0);
    const paymentAccountDiscountAmountValue = Number(paymentAccountDiscountAmount ?? 0);

    const order = await Order.findById(normalizedOrderId);
    if (!order) return sendError(res, "Order not found", 404);
    if (order.status === "completed") return sendError(res, "Order already billed", 400);

    const gstRatePct = await getGstRateForMethod(paymentMethodValue);
    const { discountAmount, serviceChargeAmount, taxAmount, total } = invoiceTotalsFromOrder(
      order,
      gstRatePct,
      paymentAccountDiscountAmountValue
    );

    let invoice;
    try {
      const invoiceNumber = await generateInvoiceNumber();
      const result = await executeBillingWithRecipeConsumption({
        orderId: normalizedOrderId,
        userId: req.user.id,
        paymentMethod: paymentMethodValue,
        amountPaid: amountPaidValue,
        discountType: discountTypeValue,
        discountValue: Number.isFinite(discountValueNumber) ? discountValueNumber : 0,
        notes: String(notes ?? ""),
        paymentAccountName: String(paymentAccountName ?? ""),
        paymentAccountDiscountType: paymentAccountDiscountTypeValue,
        paymentAccountDiscountValue: Number.isFinite(paymentAccountDiscountValueNumber) ? paymentAccountDiscountValueNumber : 0,
        paymentAccountDiscountAmount: Number.isFinite(paymentAccountDiscountAmountValue) ? paymentAccountDiscountAmountValue : 0,
        gstRatePct,
        invoiceNumber,
        discountAmount,
        serviceChargeAmount,
        taxAmount,
        total,
      });
      invoice = result.invoice;
    } catch (e: unknown) {
      const isInvoiceNumberDuplicate =
        e instanceof Error && /E11000 duplicate key error.*invoiceNumber/i.test(e.message);
      if (isInvoiceNumberDuplicate) {
        const retryInvoiceNumber = await generateInvoiceNumber();
        const retryResult = await executeBillingWithRecipeConsumption({
          orderId: normalizedOrderId,
          userId: req.user.id,
          paymentMethod: paymentMethodValue,
          amountPaid: amountPaidValue,
          discountType: discountTypeValue,
          discountValue: Number.isFinite(discountValueNumber) ? discountValueNumber : 0,
          notes: String(notes ?? ""),
          paymentAccountName: String(paymentAccountName ?? ""),
          paymentAccountDiscountType: paymentAccountDiscountTypeValue,
          paymentAccountDiscountValue: Number.isFinite(paymentAccountDiscountValueNumber) ? paymentAccountDiscountValueNumber : 0,
          paymentAccountDiscountAmount: Number.isFinite(paymentAccountDiscountAmountValue) ? paymentAccountDiscountAmountValue : 0,
          gstRatePct,
          invoiceNumber: retryInvoiceNumber,
          discountAmount,
          serviceChargeAmount,
          taxAmount,
          total,
        });
        invoice = retryResult.invoice;
      } else {
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
    }

    if (order.customer) {
      await Customer.findByIdAndUpdate(order.customer, {
        $inc: { totalSpent: total, totalOrders: 1, loyaltyPoints: Math.floor(total) },
      });
    }

    const populated = await Invoice.findById(invoice._id)
      .populate("issuedBy", "name")
      .populate({
        path: "order",
        select: "orderNumber type tableNumber",
        populate: { path: "servedBy", select: "name" },
      })
      .populate("customer", "name phone");

    return sendSuccess(res, populated, "Invoice created successfully", 201);
  } catch (error) {
    const message = error instanceof Error ? error.message || "Failed to create invoice" : "Failed to create invoice";
    console.error("Billing error:", error);
    return sendError(res, message, 500);
  }
});

export default router;
