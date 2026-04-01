import mongoose, { ClientSession } from "mongoose";
import Order from "../models/Order";
import Inventory from "../models/Inventory";
import InventoryReservation from "../models/InventoryReservation";
import { aggregateRecipeRequirements, InsufficientStockError, ShortageDetail } from "./recipeInventory";

function asShortage(inv: any | null, inventoryId: string, required: number): ShortageDetail {
  return {
    inventoryId,
    name: inv?.name || "Unknown",
    required,
    available: inv?.available ?? inv?.currentStock ?? 0,
  };
}

/**
 * Reserve inventory for an order that is moving into kitchen preparation.
 * - Idempotent: if an active reservation already exists for this order, it returns it.
 * - Validates using (currentStock - reservedStock) to prevent oversell.
 */
export async function reserveInventoryForOrder(opts: {
  orderId: string;
  userId: string;
  session?: ClientSession | null;
}) {
  const { orderId, userId, session } = opts;
  const s = session ?? null;

  const existing = await InventoryReservation.findOne({ order: orderId, status: "active" })
    .session(s)
    .lean();
  if (existing) return existing;

  const order = await Order.findById(orderId).session(s);
  if (!order) throw new Error("ORDER_NOT_FOUND");

  const requirements = await aggregateRecipeRequirements(order.items as any[], s);
  const lines: { inventoryItem: mongoose.Types.ObjectId; quantityReserved: number }[] = [];

  for (const [invId, qty] of requirements) {
    // reserve from "available" = currentStock - reservedStock
    const updated = await Inventory.findOneAndUpdate(
      {
        _id: invId,
        isActive: true,
        $expr: { $gte: [{ $subtract: ["$currentStock", { $ifNull: ["$reservedStock", 0] }] }, qty] },
      },
      { $inc: { reservedStock: qty } },
      { session: s ?? undefined, new: true }
    ).lean();

    if (!updated) {
      const inv = await Inventory.findById(invId)
        .session(s)
        .select("name currentStock reservedStock")
        .lean();
      const available =
        (inv as { currentStock?: number; reservedStock?: number } | null)?.currentStock ?? 0 -
        ((inv as { reservedStock?: number } | null)?.reservedStock ?? 0);
      throw new InsufficientStockError([
        asShortage({ ...(inv as any), available }, String(invId), qty),
      ]);
    }

    lines.push({ inventoryItem: new mongoose.Types.ObjectId(invId), quantityReserved: qty });
  }

  const [reservation] = await InventoryReservation.create(
    [
      {
        order: orderId,
        status: "active",
        lines,
        createdBy: userId,
      },
    ],
    { session: s ?? undefined }
  );

  return reservation.toObject();
}

/** Release an active reservation (e.g. order cancelled/rejected before billing). */
export async function releaseReservationForOrder(opts: { orderId: string; session?: ClientSession | null }) {
  const { orderId, session } = opts;
  const s = session ?? null;

  const resv = await InventoryReservation.findOne({ order: orderId, status: "active" }).session(s);
  if (!resv) return null;

  for (const line of resv.lines as any[]) {
    await Inventory.updateOne(
      { _id: line.inventoryItem },
      { $inc: { reservedStock: -Number(line.quantityReserved || 0) } },
      { session: s ?? undefined }
    );
  }

  resv.status = "released";
  resv.releasedAt = new Date();
  await resv.save({ session: s ?? undefined });
  return resv.toObject();
}

/**
 * Consume an active reservation during billing.
 * - Decrements currentStock by reserved quantities
 * - Decrements reservedStock by same quantities
 * - Marks reservation consumed
 */
export async function consumeReservationForOrder(opts: {
  orderId: string;
  session: ClientSession;
}) {
  const { orderId, session } = opts;
  const resv = await InventoryReservation.findOne({ order: orderId, status: "active" }).session(session);
  if (!resv) return null;

  const shortages: ShortageDetail[] = [];
  for (const line of resv.lines as any[]) {
    const qty = Number(line.quantityReserved || 0);
    if (!(qty > 0)) continue;

    const updated = await Inventory.findOneAndUpdate(
      { _id: line.inventoryItem, isActive: true, currentStock: { $gte: qty }, reservedStock: { $gte: qty } },
      { $inc: { currentStock: -qty, reservedStock: -qty } },
      { session, new: true }
    ).lean();

    if (!updated) {
      const inv = await Inventory.findById(line.inventoryItem)
        .session(session)
        .select("name currentStock reservedStock")
        .lean();
      shortages.push(asShortage(inv, String(line.inventoryItem), qty));
    }
  }

  if (shortages.length) {
    throw new InsufficientStockError(shortages);
  }

  resv.status = "consumed";
  resv.consumedAt = new Date();
  await resv.save({ session });
  return resv.toObject();
}

