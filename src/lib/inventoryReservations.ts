import mongoose, { ClientSession } from "mongoose";
import Order from "../models/Order";
import Inventory from "../models/Inventory";
import InventoryReservation from "../models/InventoryReservation";
import { aggregateRecipeRequirements } from "./recipeInventory";
import { InsufficientStockError, type ShortageDetail } from "./inventoryErrors";

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
