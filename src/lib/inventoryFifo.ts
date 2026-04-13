import mongoose, { ClientSession } from "mongoose";
import StockLayer from "../models/StockLayer";
import Inventory from "../models/Inventory";
import { InsufficientStockError } from "./inventoryErrors";

export type FifoAllocation = {
  stockLayer: mongoose.Types.ObjectId;
  quantity: number;
  unitCost: number;
};

/**
 * Decrements stock layers in FIFO order (receivedAt, _id), then applies matching Inventory.currentStock
 * (and optional reservedStock) decrement. Must run inside an active transaction session.
 */
export async function deductInventoryFifo(opts: {
  inventoryItemId: string;
  quantity: number;
  session: ClientSession;
  /** When consuming a kitchen reservation, pass the same value as quantity so reservedStock is released. */
  releaseReserved: number;
}): Promise<{ allocations: FifoAllocation[] }> {
  const { inventoryItemId, quantity, session, releaseReserved } = opts;
  if (!(quantity > 0)) {
    return { allocations: [] };
  }

  if (releaseReserved > 0 && releaseReserved !== quantity) {
    throw new Error("releaseReserved must equal quantity when set");
  }

  const invId = new mongoose.Types.ObjectId(inventoryItemId);

  const inventoryGuard: Record<string, unknown> = {
    _id: invId,
    isActive: true,
    currentStock: { $gte: quantity },
  };
  if (releaseReserved > 0) {
    inventoryGuard.reservedStock = { $gte: releaseReserved };
  }

  let need = quantity;
  const allocations: FifoAllocation[] = [];

  while (need > 0) {
    const layerRaw = await StockLayer.findOne({
      inventoryItem: invId,
      quantityRemaining: { $gt: 0 },
    })
      .sort({ receivedAt: 1, _id: 1 })
      .session(session)
      .lean();
    const layer = layerRaw as unknown as {
      _id: mongoose.Types.ObjectId;
      quantityRemaining: number;
      unitCost: number;
    } | null;

    if (!layer) {
      const inv = await Inventory.findById(invId).session(session).select("name currentStock reservedStock").lean();
      const openLayers = await StockLayer.find({ inventoryItem: invId, quantityRemaining: { $gt: 0 } })
        .session(session)
        .select("quantityRemaining")
        .lean();
      const layerSum = openLayers.reduce((s, d) => s + (Number((d as { quantityRemaining?: number }).quantityRemaining) || 0), 0);
      const cur = (inv as { currentStock?: number } | null)?.currentStock ?? 0;
      const res = (inv as { reservedStock?: number } | null)?.reservedStock ?? 0;
      const availSell = Math.max(0, cur - res);
      throw new InsufficientStockError([
        {
          inventoryId: inventoryItemId,
          name: (inv as { name?: string } | null)?.name || "Unknown",
          required: need,
          available: Math.min(availSell, layerSum),
        },
      ]);
    }

    const remainingOnLayer = Number(layer.quantityRemaining);
    const take = Math.min(need, remainingOnLayer);

    const updated = await StockLayer.findOneAndUpdate(
      { _id: layer._id, quantityRemaining: { $gte: take } },
      { $inc: { quantityRemaining: -take } },
      { session, new: true }
    ).lean();

    if (!updated) {
      continue;
    }

    allocations.push({
      stockLayer: new mongoose.Types.ObjectId(String(layer._id)),
      quantity: take,
      unitCost: Number(layer.unitCost) || 0,
    });
    need -= take;
  }

  const invUpdated = await Inventory.findOneAndUpdate(
    inventoryGuard,
    { $inc: { currentStock: -quantity, reservedStock: -releaseReserved } },
    { session, new: true }
  ).lean();

  if (!invUpdated) {
    const inv = await Inventory.findById(invId).session(session).select("name currentStock reservedStock").lean();
    const cur = (inv as { currentStock?: number } | null)?.currentStock ?? 0;
    const res = (inv as { reservedStock?: number } | null)?.reservedStock ?? 0;
    throw new InsufficientStockError([
      {
        inventoryId: inventoryItemId,
        name: (inv as { name?: string } | null)?.name || "Unknown",
        required: quantity,
        available: Math.max(0, cur - res),
      },
    ]);
  }

  return { allocations };
}
