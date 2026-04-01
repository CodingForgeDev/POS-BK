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

const router = Router();

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

    if (!type || !items?.length) {
      return sendError(res, "Order type and items are required", 400);
    }

    const subtotal = items.reduce((sum: number, item: any) => sum + item.quantity * item.price, 0);
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
      items: items.map((item: any) => ({ ...item, subtotal: item.quantity * item.price })),
      customerName: customerName || "Walk-in",
      customer: customerId || null,
      tableNumber: tableNumber || "",
      notes: notes || "",
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

    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, "Order not found", 404);
    if (["completed", "cancelled"].includes(order.status)) {
      return sendError(res, "Cannot modify a completed or cancelled order", 400);
    }

    const subtotal = items.reduce((sum: number, item: any) => sum + item.quantity * item.price, 0);
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
      items: items.map((item: any) => ({
        product: item.product,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        notes: item.notes ?? "",
        subtotal: item.quantity * item.price,
        isAddOn: Boolean(item.isAddOn),
      })),
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
