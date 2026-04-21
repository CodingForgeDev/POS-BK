import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError, generateOrderNumber } from "../lib/utils";
import Order from "../models/Order";
import { isAdminRoleName } from "../lib/role-utils";
import Customer from "../models/Customer";
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
  isReadyItem: boolean;
  station: "kitchen" | "bar";
  isAddOn: boolean;
  modifiers: NormalizedModifier[];
  subtotal: number;
};

type StationState = "accepted" | "preparing" | "ready";

type NormalizedModifierAction = NormalizedModifier["action"];

const ALLOWED_MODIFIER_ACTIONS = new Set(["add", "no", "extra", "side", "substitute"]);
const ACTIVE_ORDER_STATUSES = ["open", "accepted", "preparing", "ready"] as const;

function normalizeModifierAction(raw: unknown): NormalizedModifierAction {
  const action = String(raw ?? "add").trim().toLowerCase();
  if (ALLOWED_MODIFIER_ACTIONS.has(action)) return action as NormalizedModifier["action"];
  return "add";
}

function cleanText(raw: unknown, max = 160): string {
  return String(raw ?? "").trim().slice(0, max);
}

function normalizeProduct(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    const id = (raw as { _id?: unknown; id?: unknown })._id ?? (raw as { _id?: unknown; id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
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

function isDuplicateOrderNumberError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /E11000 duplicate key error.*orderNumber/i.test(error.message)
  );
}

function computeLineSubtotal(price: number, quantity: number, modifiers: NormalizedModifier[]): number {
  const modifierUnitDelta = modifiers.reduce((sum, mod) => sum + mod.priceDelta, 0);
  return (price + modifierUnitDelta) * quantity;
}

function sanitizeStation(raw: unknown): "kitchen" | "bar" {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "bar" ? "bar" : "kitchen";
}

function normalizeStationStatus(raw: unknown): StationState | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "preparing" || value === "ready" || value === "accepted") {
    return value as StationState;
  }
  return null;
}

function deriveStationStatus(items: NormalizedOrderItem[] | any[], station: "kitchen" | "bar"): StationState | null {
  const stationItems = Array.isArray(items)
    ? items.filter((item: any) => item.station === station)
    : [];
  if (!stationItems.length) return null;
  if (stationItems.every((item: any) => Boolean(item.isReadyItem))) return "ready";
  if (stationItems.some((item: any) => item.isReadyItem)) return "accepted";
  return "accepted";
}

function deriveGlobalOrderStatus(kitchenStatus: StationState | null, barStatus: StationState | null): string {
  const statuses = [kitchenStatus, barStatus].filter((s): s is StationState => s !== null);
  if (!statuses.length) return "accepted";
  if (statuses.every((s) => s === "ready")) return "ready";
  if (statuses.some((s) => s === "preparing")) return "preparing";
  return "accepted";
}

function sanitizeOrderItems(rawItems: unknown): NormalizedOrderItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const productRaw = (item as { product?: unknown }).product;
      const product = normalizeProduct(productRaw);
      if (!product || !mongoose.isValidObjectId(product)) return null;
      const price = Number((item as { price?: unknown }).price);
      const quantity = Number((item as { quantity?: unknown }).quantity);
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return null;
      const modifiers = sanitizeModifiers((item as { modifiers?: unknown }).modifiers);
      return {
        product,
        name: cleanText((item as { name?: unknown }).name, 120),
        price,
        quantity,
        notes: cleanText((item as { notes?: unknown }).notes, 300),
        isReadyItem: Boolean((item as { isReadyItem?: unknown }).isReadyItem),
        station: sanitizeStation((item as { station?: unknown }).station),
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
    if (status && status !== "all") {
      if (status === "active") {
        query.status = { $in: ACTIVE_ORDER_STATUSES };
      } else {
        query.status = status;
      }
    }
    if (type && type !== "all") query.type = type;
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }
    if (!(await isAdminRoleName(req.user.role))) {
      query.servedBy = req.user.id;
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
    const { type, items, customerName, customerPhone, customerId, tableNumber, notes, discount, status, paymentMethod } = req.body;
    const normalizedItems = sanitizeOrderItems(items);

    if (!type || !normalizedItems.length) {
      return sendError(res, "Order type and at least one valid item are required", 400);
    }

    if (type === "dine-in") {
      const table = String(tableNumber || "").trim();
      if (!table) {
        return sendError(res, "Table number is required for dine-in orders", 400);
      }
      const tableTaken = await Order.exists({
        type: "dine-in",
        tableNumber: table,
        status: { $in: ACTIVE_ORDER_STATUSES },
      });
      if (tableTaken) {
        return sendError(res, `Table ${table} is already occupied`, 409);
      }
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

    const allReady = normalizedItems.length > 0 && normalizedItems.every((item) => item.isReadyItem);
    const kitchenStatus = normalizedItems.some((item) => item.station === "kitchen")
      ? normalizedItems.filter((item) => item.station === "kitchen").every((item) => item.isReadyItem)
        ? "ready"
        : "accepted"
      : null;
    const barStatus = normalizedItems.some((item) => item.station === "bar")
      ? normalizedItems.filter((item) => item.station === "bar").every((item) => item.isReadyItem)
        ? "ready"
        : "accepted"
      : null;
    const orderStatus =
      status && ["open", "accepted", "rejected", "preparing", "ready"].includes(status)
        ? status
        : allReady
          ? "ready"
          : "accepted";

    const validCustomerId = typeof customerId === "string" && mongoose.isValidObjectId(customerId) ? customerId : null;
    const phoneValue = typeof customerPhone === "string" ? customerPhone.trim() : "";
    const normalizedPhone = phoneValue.replace(/[^+\d]/g, "");

    let linkedCustomerId = validCustomerId;
    let linkedCustomerName = customerName || "Walk-in";
    if (!linkedCustomerId && normalizedPhone) {
      const trimmedName = typeof customerName === "string" ? customerName.trim() : "";
      if (trimmedName && trimmedName.toLowerCase() !== "walk-in") {
        const existingCustomer = await Customer.findOne({ phone: normalizedPhone });
        if (existingCustomer) {
          linkedCustomerId = existingCustomer._id;
          linkedCustomerName = existingCustomer.name || trimmedName;
          if (existingCustomer.name !== trimmedName) {
            existingCustomer.name = trimmedName;
            await existingCustomer.save();
          }
        } else {
          const createdCustomer = await Customer.create({
            name: trimmedName,
            phone: normalizedPhone,
          });
          linkedCustomerId = createdCustomer._id;
          linkedCustomerName = createdCustomer.name;
        }
      }
    }

    let order: any = null;
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      const orderNumber = await generateOrderNumber();
      try {
        order = await Order.create({
          orderNumber,
          type,
          status: orderStatus,
          items: normalizedItems,
          customerName: linkedCustomerName || "Walk-in",
          customer: linkedCustomerId,
          tableNumber: tableNumber || "",
          notes: cleanText(notes, 500),
          subtotal,
          taxAmount,
          discountAmount,
          serviceChargeAmount,
          total,
          kitchenStatus,
          barStatus,
          servedBy: req.user.id,
        });
        break;
      } catch (error) {
        if (isDuplicateOrderNumberError(error) && attempt < maxAttempts - 1) {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }

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
      "servedAt",
    ];
    const updates: Record<string, unknown> = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
    if (req.body.servedAt !== undefined) {
      const servedDate = new Date(req.body.servedAt);
      if (!Number.isNaN(servedDate.getTime())) {
        updates.servedAt = servedDate;
      } else {
        updates.servedAt = null;
      }
    }

    const station = req.body.station ? sanitizeStation(req.body.station) : null;
    const stationStatus = station ? normalizeStationStatus(req.body.stationStatus) : null;
    const stationPromised = typeof req.body.stationPromisedPrepMinutes === 'number'
      ? Number(req.body.stationPromisedPrepMinutes)
      : null;

    const orderId = req.params.id;
    const order = await Order.findById(orderId);
    if (!order) return sendError(res, 'Order not found', 404);
    if (['completed', 'cancelled'].includes(order.status)) {
      return sendError(res, 'Cannot modify a completed or cancelled order', 400);
    }

    if (station && stationStatus) {
      updates[`${station}Status`] = stationStatus;
      if (stationStatus === 'preparing') {
        updates[`${station}PromisedPrepMinutes`] = stationPromised || null;
        updates[`${station}PreparingStartedAt`] = new Date();
      } else if (stationStatus === 'ready') {
        const updatedItems = order.items.map((item: any) =>
          item.station === station ? { ...item, isReadyItem: true } : item
        );
        updates.items = updatedItems;
      } else if (stationStatus === 'accepted') {
        updates[`${station}PromisedPrepMinutes`] = null;
        updates[`${station}PreparingStartedAt`] = null;
      }
    }

    if (req.body.items !== undefined) {
      const normalizedItems = sanitizeOrderItems(req.body.items);
      if (!normalizedItems.length) {
        return sendError(res, 'At least one valid item is required', 400);
      }
      const subtotal = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
      const [gstRatePct, servicePct] = await Promise.all([
        getGstRateForMethod('default'),
        getDineInServiceChargePercent(),
      ]);
      const { serviceChargeAmount, taxAmount, total } = computeOrderFinancials({
        subtotal,
        discountAmountFixed: order.discountAmount || 0,
        orderType: order.type,
        serviceChargePercent: servicePct,
        gstRatePct,
      });

      updates.items = normalizedItems;
      updates.subtotal = subtotal;
      updates.taxAmount = taxAmount;
      updates.serviceChargeAmount = serviceChargeAmount;
      updates.total = total;
    }

    const nextStatus = typeof updates.status === 'string' ? updates.status : undefined;
    if (nextStatus === 'preparing' && !station) {
      const stationKey = order.items.some((item: any) => item.station === 'kitchen') && !order.items.some((item: any) => item.station === 'bar')
        ? 'kitchen'
        : order.items.some((item: any) => item.station === 'bar') && !order.items.some((item: any) => item.station === 'kitchen')
          ? 'bar'
          : null;
      if (stationKey) {
        updates[`${stationKey}Status`] = 'preparing';
        updates[`${stationKey}PreparingStartedAt`] = new Date();
      }
      updates.preparingStartedAt = new Date();
    }
    if (nextStatus === 'ready' && !station) {
      const stationKey = order.items.some((item: any) => item.station === 'kitchen') && !order.items.some((item: any) => item.station === 'bar')
        ? 'kitchen'
        : order.items.some((item: any) => item.station === 'bar') && !order.items.some((item: any) => item.station === 'kitchen')
          ? 'bar'
          : null;
      if (stationKey) {
        const updatedItems = order.items.map((item: any) =>
          item.station === stationKey ? { ...item, isReadyItem: true } : item
        );
        updates.items = updatedItems;
        updates[`${stationKey}Status`] = 'ready';
      }
    }

    const currentItems = (updates.items as any[]) ?? order.items;
    const currentKitchenStatus = (updates.kitchenStatus as StationState) ?? order.kitchenStatus ?? deriveStationStatus(currentItems, 'kitchen');
    const currentBarStatus = (updates.barStatus as StationState) ?? order.barStatus ?? deriveStationStatus(currentItems, 'bar');
    const derivedStatus = deriveGlobalOrderStatus(currentKitchenStatus, currentBarStatus);
    if (!updates.status && !['rejected', 'cancelled', 'completed'].includes(order.status)) {
      updates.status = derivedStatus;
    }

    if (updates.status === 'preparing' || updates.status === 'cancelled' || updates.status === 'rejected') {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (updates.status === 'preparing') {
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
        const isTransactionUnavailable = code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg);
        if (isTransactionUnavailable) {
          console.warn('Transactions unavailable, falling back to non-transactional order update.');
          try {
            if (updates.status === 'preparing') {
              await reserveInventoryForOrder({ orderId, userId: req.user.id, session: null });
            } else {
              await releaseReservationForOrder({ orderId, session: null });
            }
            await Order.updateOne({ _id: orderId }, updates);
          } catch (innerError: unknown) {
            if (innerError instanceof InsufficientStockError) {
              return sendError(res, innerError.message, 409, {
                code: innerError.code,
                shortages: innerError.shortages,
              });
            }
            console.error('Order update fallback error:', innerError);
            return sendError(res, 'Failed to update order', 500);
          }
        } else {
          throw e;
        }
      } finally {
        session.endSession();
      }
    } else {
      await Order.updateOne({ _id: orderId }, updates);
    }

    const updated = await Order.findById(orderId)
      .populate('customer', 'name phone')
      .populate('servedBy', 'name');

    if (!updated) return sendError(res, 'Order not found', 404);
    return sendSuccess(res, updated, 'Order updated successfully');
  } catch (error) {
    return sendError(res, 'Failed to update order', 500);
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

    const newKitchenStatus = deriveStationStatus(normalizedItems, "kitchen");
    const newBarStatus = deriveStationStatus(normalizedItems, "bar");

    const updatePayload: Record<string, unknown> = {
      items: normalizedItems,
      subtotal,
      taxAmount,
      serviceChargeAmount,
      total,
    };

    if (status && ["accepted", "preparing", "ready"].includes(status)) {
      updatePayload.status = status;
      if (newKitchenStatus) {
        updatePayload.kitchenStatus = status === "preparing" && newKitchenStatus !== "ready"
          ? "preparing"
          : status === "ready"
            ? "ready"
            : newKitchenStatus;
      }
      if (newBarStatus) {
        updatePayload.barStatus = status === "preparing" && newBarStatus !== "ready"
          ? "preparing"
          : status === "ready"
            ? "ready"
            : newBarStatus;
      }
    } else {
      if (newKitchenStatus) updatePayload.kitchenStatus = newKitchenStatus;
      if (newBarStatus) updatePayload.barStatus = newBarStatus;
      updatePayload.status = deriveGlobalOrderStatus(newKitchenStatus, newBarStatus);
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
