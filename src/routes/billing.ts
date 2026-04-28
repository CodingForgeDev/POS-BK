import mongoose from "mongoose";
import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError, generateInvoiceNumber } from "../lib/utils";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import JournalEntry from "../models/JournalEntry";
import { isAdminOrManagerRoleName } from "../lib/role-utils";
import Customer from "../models/Customer";
import { getGstRateForMethod } from "../lib/gst";
import { reverseJournalEntryRecord } from "../lib/journalPosting";
import {
  executeBillingWithRecipeConsumption,
  InsufficientStockError,
} from "../lib/recipeInventory";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when refundRequest is a Mongoose-generated ghost object:
 * an auto-initialized sub-doc that has no real data (no requestedBy, no items,
 * no meaningful notes). We treat these as null so they never block real requests.
 *
 * Handles all edge cases:
 *   - actual null / undefined
 *   - empty object {}
 *   - sub-doc with only schema defaults filled in
 */
function isGhostRefundRequest(r: any): boolean {
  if (r == null) return true;
  if (typeof r !== "object") return true;

  // If there's a real requestedBy, it's a genuine request
  if (r.requestedBy) return false;

  // If status is anything other than "pending" with no requester, trust it
  if (r.status && r.status !== "pending") return false;

  // Ghost: pending with no actor, no timestamp, no real items, no notes
  const hasItems = Array.isArray(r.items) && r.items.length > 0;
  const hasNotes = typeof r.notes === "string" && r.notes.trim().length > 0;
  const hasTimestamp = Boolean(r.requestedAt);

  return !hasItems && !hasNotes && !hasTimestamp;
}

function sanitizeInvoice(invoice: any) {
  if (!invoice) return invoice;
  if (isGhostRefundRequest(invoice.refundRequest)) {
    invoice.refundRequest = null;
  }
  return invoice;
}

function invoiceTotalsFromOrder(
  order: any,
  gstRatePct: number,
  paymentAccountDiscountAmount = 0
) {
  const discountAmount = order.discountAmount || 0;
  const serviceChargeAmount = Number(order.serviceChargeAmount) || 0;
  const existingTaxAmount = Number(order.taxAmount) || 0;
  const existingTotal = Number(order.total) || 0;

  if (Number.isFinite(existingTotal) && existingTotal > 0) {
    const total = Math.max(0, existingTotal - Math.max(0, paymentAccountDiscountAmount));
    return { discountAmount, serviceChargeAmount, taxAmount: existingTaxAmount, total };
  }

  const afterDiscount = Math.max(0, order.subtotal - discountAmount);
  const taxableBase = Math.max(
    0,
    afterDiscount + serviceChargeAmount - Math.max(0, paymentAccountDiscountAmount)
  );
  const rate = Math.max(0, Math.min(100, gstRatePct));
  const taxAmount = (taxableBase * rate) / 100;
  const total = taxableBase + taxAmount;
  return { discountAmount, serviceChargeAmount, taxAmount, total };
}

const FULL_POPULATE = [
  { path: "issuedBy", select: "name" },
  {
    path: "order",
    select: "orderNumber type tableNumber",
    populate: { path: "servedBy", select: "name" },
  },
  { path: "customer", select: "name phone" },
  { path: "refundedBy", select: "name" },
  { path: "refundRequest.requestedBy", select: "name" },
  { path: "refundRequest.approvedBy", select: "name" },
  { path: "refundRequest.rejectedBy", select: "name" },
];

async function fetchPopulatedInvoice(id: any) {
  const doc = await Invoice.findById(id).populate(FULL_POPULATE as any).lean();
  return sanitizeInvoice(doc);
}

async function reverseSaleJournalForInvoice(invoice: any, postedBy: any) {
  if (!invoice || !invoice.order) {
    return null;
  }

  const originalSale = (await JournalEntry.findOne({ source: "POS", sourceId: invoice.order }).lean()) as any;
  if (!originalSale) {
    console.warn("No original POS journal entry found for refund reversal", { order: invoice.order });
    return null;
  }

  const reversalReference = `REV-${String(originalSale.reference || originalSale._id)}`;
  const existingReversal = await JournalEntry.findOne({ reference: reversalReference, source: "MANUAL" }).lean();
  if (existingReversal) {
    return existingReversal;
  }

  return reverseJournalEntryRecord(originalSale, {
    reference: reversalReference,
    postedBy,
    status: "posted",
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

const router: Router = Router();

// GET /billing
router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { page = "1", limit = "20", date, startDate, endDate, method } = req.query as Record<string, string>;

    const query: any = {};
    if (startDate || endDate) {
      const start = new Date(startDate || endDate || date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate || startDate || date);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    } else if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }
    if (method) query.paymentMethod = method;
    if (!(await isAdminOrManagerRoleName(req.user.role))) {
      query.issuedBy = req.user.id;
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const total = await Invoice.countDocuments(query);
    let invoices = await Invoice.find(query)
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

    invoices = invoices.map(sanitizeInvoice);
    return sendSuccess(res, { invoices, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("[GET /billing]", error);
    return sendError(res, "Failed to fetch invoices", 500);
  }
});

// GET /billing/refund-requests
router.get("/refund-requests", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!(await isAdminOrManagerRoleName(req.user.role))) {
      return sendError(res, "Unauthorized", 403);
    }

    const { status = "pending", page = "1", limit = "20", startDate, endDate } = req.query as Record<string, string>;
    const allowedStatuses = ["pending", "approved", "rejected", "all"];
    const normalizedStatus = allowedStatuses.includes(status) ? status : "pending";

    const query: any = { "refundRequest.requestedBy": { $ne: null } };
    if (normalizedStatus !== "all") {
      query["refundRequest.status"] = normalizedStatus;
    }

    const requestedAtFilter: any = {};
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      if (!Number.isNaN(start.getTime())) {
        requestedAtFilter.$gte = start;
      }
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      if (!Number.isNaN(end.getTime())) {
        requestedAtFilter.$lte = end;
      }
    }
    if (Object.keys(requestedAtFilter).length) {
      query["refundRequest.requestedAt"] = requestedAtFilter;
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
      .populate("refundRequest.requestedBy", "name")
      .populate("refundRequest.approvedBy", "name")
      .populate("refundRequest.rejectedBy", "name")
      .sort({ "refundRequest.requestedAt": -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return sendSuccess(res, { invoices, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("[GET /billing/refund-requests]", error);
    return sendError(res, "Failed to fetch refund requests", 500);
  }
});

// GET /billing/:id
router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return sendError(res, "Invalid invoice ID", 400);
    }

    const invoice = await fetchPopulatedInvoice(id);
    if (!invoice) return sendError(res, "Invoice not found", 404);

    const issuedById =
      typeof invoice.issuedBy === "object"
        ? String((invoice.issuedBy as any)?._id)
        : String(invoice.issuedBy);

    if (
      !(await isAdminOrManagerRoleName(req.user.role)) &&
      issuedById !== req.user.id
    ) {
      return sendError(res, "Not authorized to view this invoice", 403);
    }

    return sendSuccess(res, invoice);
  } catch (error) {
    console.error("[GET /billing/:id]", error);
    return sendError(res, "Failed to fetch invoice", 500);
  }
});







// POST /billing/:id/refund-requests — cashier submits refund request for approval
// POST /billing/:id/refund-requests
// Replace ONLY this route handler in your invoices router.
// The fix: use findByIdAndUpdate with $set instead of document.save(),
// which skips full-document validation (we only need to validate the new fields).

router.post(
  "/:id/refund-requests",
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await connectDB();
      const { id } = req.params;

      // ── Input validation ─────────────────────────────────────────────────
      if (!id || !mongoose.isValidObjectId(id)) {
        return sendError(res, "Invalid invoice ID", 400);
      }

      const notes = String(req.body.notes ?? "").trim();
      if (!notes) {
        return sendError(res, "Refund reason is required", 400);
      }

      const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
      if (!rawItems.length) {
        return sendError(res, "Select at least one item to refund", 400);
      }

      // ── Load invoice ─────────────────────────────────────────────────────
      const invoice = await Invoice.findById(id).lean() as any;
      if (!invoice) return sendError(res, "Invoice not found", 404);

      if (invoice.status === "refunded") {
        return sendError(res, "Invoice is already fully refunded", 400);
      }

      // ── Ghost-request guard ──────────────────────────────────────────────
      const isGhost = isGhostRefundRequest(invoice.refundRequest);
      if (!isGhost && invoice.refundRequest?.status === "pending") {
        return sendError(res, "A refund request is already pending for this invoice", 409);
      }

      // ── Build & validate items ───────────────────────────────────────────
      const invoiceItemMap = new Map<string, { quantity: number; price: number }>(
        (invoice.items || []).map((i: any) => [
          String(i.name || "").toLowerCase().trim(),
          { quantity: Number(i.quantity), price: Number(i.price) },
        ])
      );

      const validItems: Array<{
        name: string;
        quantity: number;
        price: number;
        refundQuantity: number;
        refundAmount: number;
      }> = [];

      for (const item of rawItems) {
        if (!item || !item.name) continue;

        const name = String(item.name).trim();
        const refundQuantity = Math.floor(Number(item.refundQuantity) || 0);
        if (refundQuantity <= 0) continue;

        const original = invoiceItemMap.get(name.toLowerCase());
        if (!original) {
          return sendError(res, `Item "${name}" does not exist in this invoice`, 422);
        }
        if (refundQuantity > original.quantity) {
          return sendError(
            res,
            `Refund quantity for "${name}" (${refundQuantity}) exceeds original quantity (${original.quantity})`,
            422
          );
        }

        const price = Number(item.price) > 0 ? Number(item.price) : original.price;
        const refundAmount = Math.round(refundQuantity * price * 100) / 100;

        validItems.push({
          name,
          quantity: refundQuantity,
          price,
          refundQuantity,
          refundAmount,
        });
      }

      if (!validItems.length) {
        return sendError(res, "Select at least one valid item to refund", 400);
      }

      // ── Persist using $set to skip full-document re-validation ───────────
      // invoice.save() re-validates ALL fields including items[].total which
      // may be missing on old documents. findByIdAndUpdate only touches the
      // fields we explicitly set, so old item data is never re-validated.
      const refundRequestPayload = {
        requestedBy: req.user.id,
        requestedAt: new Date(),
        notes,
        items: validItems,
        status: "pending",
        approvedBy: null,
        approvedAt: null,
        approvalNotes: "",
        rejectedBy: null,
        rejectedAt: null,
        rejectionNotes: "",
      };

      await Invoice.findByIdAndUpdate(
        id,
        { $set: { refundRequest: refundRequestPayload } },
        { runValidators: false } // skip full-doc validation
      );

      return sendSuccess(
        res,
        await fetchPopulatedInvoice(id),
        "Refund request submitted successfully",
        201
      );
    } catch (error: any) {
      console.error("[POST /billing/:id/refund-requests] ERROR:", {
        message: error?.message,
        name: error?.name,
        code: error?.code,
      });
      return sendError(res, "Failed to submit refund request", 500);
    }
  }
);

// Also apply the same $set pattern to approve and reject:

router.post(
  "/refund-requests/:id/approve",
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await connectDB();
      if (!(await isAdminOrManagerRoleName(req.user.role))) {
        return sendError(res, "Unauthorized", 403);
      }

      const { id } = req.params;
      if (!id || !mongoose.isValidObjectId(id)) {
        return sendError(res, "Invalid invoice ID", 400);
      }

      const notes = String(req.body.notes ?? "").trim();
      if (!notes) return sendError(res, "Approval notes are required", 400);

      const invoice = await Invoice.findById(id).lean() as any;
      if (!invoice) return sendError(res, "Invoice not found", 404);

      if (isGhostRefundRequest(invoice.refundRequest)) {
        return sendError(res, "No pending refund request found", 400);
      }
      if (invoice.refundRequest?.status !== "pending") {
        return sendError(res, "No pending refund request found", 400);
      }

      const approvedAmount = (invoice.refundRequest.items || []).reduce(
        (sum: number, item: any) => sum + Number(item.refundAmount || 0),
        0
      );

      const newStatus = approvedAmount >= invoice.total ? "refunded" : "partial";

      await Invoice.findByIdAndUpdate(
        id,
        {
          $set: {
            refundAmount: approvedAmount,
            status: newStatus,
            refundedAt: new Date(),
            refundedBy: req.user.id,
            refundNotes: notes,
            "refundRequest.status": "approved",
            "refundRequest.approvedBy": req.user.id,
            "refundRequest.approvedAt": new Date(),
            "refundRequest.approvalNotes": notes,
          },
        },
        { runValidators: false }
      );

      if (newStatus === "refunded") {
        const updatedInvoice = await Invoice.findById(id).lean();
        if (updatedInvoice) {
          await reverseSaleJournalForInvoice(updatedInvoice, req.user.id);
        }
      }

      return sendSuccess(
        res,
        await fetchPopulatedInvoice(id),
        "Refund approved successfully"
      );
    } catch (error) {
      console.error("[POST /billing/refund-requests/:id/approve]", error);
      return sendError(res, "Failed to approve refund", 500);
    }
  }
);

router.post(
  "/refund-requests/:id/reject",
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await connectDB();
      if (!(await isAdminOrManagerRoleName(req.user.role))) {
        return sendError(res, "Unauthorized", 403);
      }

      const { id } = req.params;
      if (!id || !mongoose.isValidObjectId(id)) {
        return sendError(res, "Invalid invoice ID", 400);
      }

      const notes = String(req.body.notes ?? "").trim();
      if (!notes) return sendError(res, "Rejection reason is required", 400);

      const invoice = await Invoice.findById(id).lean() as any;
      if (!invoice) return sendError(res, "Invoice not found", 404);

      if (isGhostRefundRequest(invoice.refundRequest)) {
        return sendError(res, "No pending refund request found", 400);
      }
      if (invoice.refundRequest?.status !== "pending") {
        return sendError(res, "No pending refund request found", 400);
      }

      await Invoice.findByIdAndUpdate(
        id,
        {
          $set: {
            "refundRequest.status": "rejected",
            "refundRequest.rejectedBy": req.user.id,
            "refundRequest.rejectedAt": new Date(),
            "refundRequest.rejectionNotes": notes,
          },
        },
        { runValidators: false }
      );

      return sendSuccess(
        res,
        await fetchPopulatedInvoice(id),
        "Refund request rejected"
      );
    } catch (error) {
      console.error("[POST /billing/refund-requests/:id/reject]", error);
      return sendError(res, "Failed to reject refund request", 500);
    }
  }
);

// POST /billing/:id/refund — direct full refund (admin/manager only, bypasses request flow)
router.post(
  "/:id/refund",
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await connectDB();
      const { id } = req.params;
      if (!id || !mongoose.isValidObjectId(id)) {
        return sendError(res, "Invalid invoice ID", 400);
      }

      const notes = String(req.body.notes ?? "").trim();
      if (!notes) return sendError(res, "Refund notes are required", 400);

      if (!(await isAdminOrManagerRoleName(req.user.role))) {
        return sendError(res, "Unauthorized", 403);
      }

      const invoice = await Invoice.findById(id);
      if (!invoice) return sendError(res, "Invoice not found", 404);
      if (invoice.status === "refunded") {
        return sendError(res, "Invoice already refunded", 400);
      }

      invoice.status = "refunded";
      invoice.refundAmount = invoice.total;
      invoice.refundNotes = notes;
      invoice.refundedAt = new Date();
      invoice.refundedBy = req.user.id;
      await invoice.save();

      await reverseSaleJournalForInvoice(invoice, req.user.id);

      return sendSuccess(
        res,
        await fetchPopulatedInvoice(invoice._id),
        "Invoice refunded successfully"
      );
    } catch (error) {
      console.error("[POST /billing/:id/refund]", error);
      return sendError(res, "Failed to refund invoice", 500);
    }
  }
);

// POST /billing — create invoice
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
    if (!normalizedOrderId) return sendError(res, "Order ID is required", 400);

    const paymentMethodValue = String(paymentMethod ?? "").trim();
    if (!paymentMethodValue) return sendError(res, "Payment method is required", 400);

    const amountPaidValue = Number(amountPaid);
    if (!Number.isFinite(amountPaidValue) || amountPaidValue < 0) {
      return sendError(res, "Amount paid must be a valid non-negative number", 400);
    }

    const discountTypeValue = ["percentage", "fixed", "none"].includes(String(discountType ?? ""))
      ? String(discountType)
      : "none";
    const discountValueNumber = Number(discountValue ?? 0);
    const paymentAccountDiscountTypeValue = ["percentage", "fixed", "none"].includes(
      String(paymentAccountDiscountType ?? "")
    )
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

    const billingBase = {
      orderId: normalizedOrderId,
      userId: req.user.id,
      paymentMethod: paymentMethodValue,
      amountPaid: amountPaidValue,
      discountType: discountTypeValue,
      discountValue: Number.isFinite(discountValueNumber) ? discountValueNumber : 0,
      notes: String(notes ?? ""),
      paymentAccountName: String(paymentAccountName ?? ""),
      paymentAccountDiscountType: paymentAccountDiscountTypeValue,
      paymentAccountDiscountValue: Number.isFinite(paymentAccountDiscountValueNumber)
        ? paymentAccountDiscountValueNumber
        : 0,
      paymentAccountDiscountAmount: Number.isFinite(paymentAccountDiscountAmountValue)
        ? paymentAccountDiscountAmountValue
        : 0,
      gstRatePct,
      discountAmount,
      serviceChargeAmount,
      taxAmount,
      total,
    };

    let invoice: any;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const invoiceNumber = await generateInvoiceNumber();
        const result = await executeBillingWithRecipeConsumption({ ...billingBase, invoiceNumber });
        invoice = result.invoice;
        break;
      } catch (e: unknown) {
        lastError = e;
        const isDuplicate =
          e instanceof Error && /E11000 duplicate key error.*invoiceNumber/i.test(e.message);
        if (!isDuplicate) {
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
    }
    if (!invoice) {
      throw lastError ?? new Error("Failed to create invoice");
    }

    if (order.customer) {
      await Customer.findByIdAndUpdate(order.customer, {
        $inc: { totalSpent: total, totalOrders: 1, loyaltyPoints: Math.floor(total) },
      });
    }

    return sendSuccess(
      res,
      await fetchPopulatedInvoice(invoice._id),
      "Invoice created successfully",
      201
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message || "Failed to create invoice" : "Failed to create invoice";
    console.error("[POST /billing]", error);
    return sendError(res, message, 500);
  }
});

export default router;