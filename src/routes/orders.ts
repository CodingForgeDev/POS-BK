import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError, generateOrderNumber } from "../lib/utils";
import Order from "../models/Order";
import { getGstRateForMethod } from "../lib/gst";
import { computeOrderFinancials } from "../lib/orderAmounts";
import { getDineInServiceChargePercent } from "../lib/serviceCharge";
import { reserveInventoryForOrder, releaseReservationForOrder } from "../lib/inventoryReservations";
import { InsufficientStockError } from "../lib/recipeInventory";

const router: Router = Router();

type NormalizedModifier = {
  groupName: string;
  optionName: string;
  action: "add" | "no" | "extra" | "side" | "substitute";
  priceDelta: number;
};

type NormalizedOrderItem = {
  product: unknown;
  name: string;
  price: number;
  quantity: number;
  notes: string;
  isAddOn: boolean;
  modifiers: NormalizedModifier[];
  subtotal: number;
};

const ALLOWED_MODIFIER_ACTIONS = new Set(["add", "no", "extra", "side", "substitute"]);

function normalizeModifierAction(raw: unknown): NormalizedModifier["action"] {
  const action = String(raw ?? "add").trim().toLowerCase();
  if (ALLOWED_MODIFIER_ACTIONS.has(action)) return action as NormalizedModifier["action"];
  return "add";
}

function cleanText(raw: unknown, max = 160): string {
  return String(raw ?? "").trim().slice(0, max);
}

function sanitizeModifiers(raw: unknown): NormalizedModifier[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedModifier[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const groupName = cleanText((m as { groupName?: unknown }).groupName, 80);
    const optionName = cleanText((m as { optionName?: unknown }).optionName, 80);
    if (!groupName || !optionName) continue;
    const priceDelta = Number((m as { priceDelta?: unknown }).priceDelta ?? 0);
    out.push({
      groupName,
      optionName,
      action: normalizeModifierAction((m as { action?: unknown }).action),
      priceDelta: Number.isFinite(priceDelta) ? priceDelta : 0,
    });
    if (out.length >= 24) break;
  }
  return out;
}

function computeLineSubtotal(price: number, quantity: number, modifiers: NormalizedModifier[]): number {
  const modifierUnitDelta = modifiers.reduce((sum, mod) => sum + mod.priceDelta, 0);
  return (price + modifierUnitDelta) * quantity;
}

function sanitizeOrderItems(rawItems: unknown): NormalizedOrderItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const price = Number((item as { price?: unknown }).price);
      const quantity = Number((item as { quantity?: unknown }).quantity);
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return null;
      const modifiers = sanitizeModifiers((item as { modifiers?: unknown }).modifiers);
      return {
        product: (item as { product?: unknown }).product,
        name: cleanText((item as { name?: unknown }).name, 120),
        price,
        quantity,
        notes: cleanText((item as { notes?: unknown }).notes, 300),
        isAddOn: Boolean((item as { isAddOn?: unknown }).isAddOn),
        modifiers,
        subtotal: computeLineSubtotal(price, quantity, modifiers),
      } as NormalizedOrderItem;
    })
    .filter((x): x is NormalizedOrderItem => Boolean(x));
}

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { status, type, date, page = "1", limit = "50" } = req.query as Record<string, string>;

    const query: any = {};
    if (status && status !== "all") query.status = status;
    if (type && type !== "all") query.type = type;
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const total = await Order.countDocuments(query);
    const orders = await Order.find(query)
      .populate("customer", "name phone")
      .populate("servedBy", "name")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return sendSuccess(res, { orders, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("Get orders error:", error);
    return sendError(res, "Failed to fetch orders", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type, items, customerName, customerId, tableNumber, notes, discount, status, paymentMethod } = req.body;
    const normalizedItems = sanitizeOrderItems(items);

    if (!type || !normalizedItems.length) {
      return sendError(res, "Order type and items are required", 400);
    }

    const subtotal = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
    const [gstRatePct, servicePct] = await Promise.all([
      getGstRateForMethod(paymentMethod || "default"),
      getDineInServiceChargePercent(),
    ]);
    const { discountAmount, serviceChargeAmount, taxAmount, total } = computeOrderFinancials({
      subtotal,
      discount,
      orderType: type,
      serviceChargePercent: servicePct,
      gstRatePct,
    });

    const orderStatus =
      status && ["open", "accepted", "rejected", "preparing", "ready"].includes(status)
        ? status
        : "accepted";

    const order = await Order.create({
      orderNumber: generateOrderNumber(),
      type,
      status: orderStatus,
      items: normalizedItems,
      customerName: customerName || "Walk-in",
      customer: customerId || null,
      tableNumber: tableNumber || "",
      notes: cleanText(notes, 500),
      subtotal,
      taxAmount,
      discountAmount,
      serviceChargeAmount,
      total,
      servedBy: req.user.id,
    });

    return sendSuccess(res, order, "Order created successfully", 201);
  } catch (error) {
    console.error("Create order error:", error);
    return sendError(res, "Failed to create order", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const order = await Order.findById(req.params.id)
      .populate("customer", "name phone email")
      .populate("servedBy", "name");

    if (!order) return sendError(res, "Order not found", 404);
    return sendSuccess(res, order);
  } catch (error) {
    return sendError(res, "Failed to fetch order", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const allowedFields = [
      "status",
      "notes",
      "kotPrinted",
      "kotPrintedAt",
      "tableNumber",
      "promisedPrepMinutes",
    ];
    const updates: Record<string, unknown> = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
    if (updates.status === "preparing") {
      updates.preparingStartedAt = new Date();
    }

    const nextStatus = updates.status as string | undefined;
    const orderId = req.params.id;

    // Reserve/release inventory around kitchen start/cancel decisions.
    // This uses a transaction when available; on standalone MongoDB it will error similarly to billing.
    if (nextStatus === "preparing" || nextStatus === "cancelled" || nextStatus === "rejected") {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (nextStatus === "preparing") {
            await reserveInventoryForOrder({ orderId, userId: req.user.id, session });
          } else {
            await releaseReservationForOrder({ orderId, session });
          }
          await Order.updateOne({ _id: orderId }, updates, { session });
        });
      } catch (e: unknown) {
        if (e instanceof InsufficientStockError) {
          return sendError(res, e.message, 409, { code: e.code, shortages: e.shortages });
        }
        const msg = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: number })?.code;
        if (code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg)) {
          return sendError(
            res,
            "MongoDB transactions require a replica set. Use MongoDB Atlas or run mongod with --replSet (see server/MONGODB-TRANSACTIONS.md).",
            503
          );
        }
        throw e;
      } finally {
        session.endSession();
      }
    } else {
      await Order.updateOne({ _id: orderId }, updates);
    }

    const order = await Order.findById(orderId)
      .populate("customer", "name phone")
      .populate("servedBy", "name");

    if (!order) return sendError(res, "Order not found", 404);
    return sendSuccess(res, order, "Order updated successfully");
  } catch (error) {
    return sendError(res, "Failed to update order", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized: Insufficient permissions", 403);
    }
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return sendError(res, "Order not found", 404);
    return sendSuccess(res, null, "Order deleted successfully");
  } catch (error) {
    return sendError(res, "Failed to delete order", 500);
  }
});

router.patch("/:id/items", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { items, status } = req.body;
    const normalizedItems = sanitizeOrderItems(items);

    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, "Order not found", 404);
    if (["completed", "cancelled"].includes(order.status)) {
      return sendError(res, "Cannot modify a completed or cancelled order", 400);
    }

    if (!normalizedItems.length) {
      return sendError(res, "At least one valid item is required", 400);
    }
    const subtotal = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
    const [gstRatePct, servicePct] = await Promise.all([
      getGstRateForMethod("default"),
      getDineInServiceChargePercent(),
    ]);
    const { serviceChargeAmount, taxAmount, total } = computeOrderFinancials({
      subtotal,
      discountAmountFixed: order.discountAmount || 0,
      orderType: order.type,
      serviceChargePercent: servicePct,
      gstRatePct,
    });

    const updatePayload: Record<string, unknown> = {
      items: normalizedItems,
      subtotal,
      taxAmount,
      serviceChargeAmount,
      total,
    };

    if (status && ["accepted", "preparing", "ready"].includes(status)) {
      updatePayload.status = status;
    }

    const updated = await Order.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
      .populate("customer", "name phone")
      .populate("servedBy", "name");

    return sendSuccess(res, updated, "Order items updated");
  } catch (error) {
    console.error("Update order items error:", error);
    return sendError(res, "Failed to update order items", 500);
  }
});

export default router;
