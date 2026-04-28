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
  session: ClientSession | null;
  /** When consuming a kitchen reservation, pass the same value as quantity so reservedStock is released. */
  releaseReserved: number;
  preferredPurchaseIds?: string[];
}): Promise<{ allocations: FifoAllocation[] }> {
  const { inventoryItemId, quantity, session, releaseReserved, preferredPurchaseIds } = opts;
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
  let searchPreferred = Array.isArray(preferredPurchaseIds) && preferredPurchaseIds.length > 0;
  const preferredOids = searchPreferred
    ? preferredPurchaseIds!.map((id) => new mongoose.Types.ObjectId(id))
    : [];

  while (need > 0) {
    const layerQuery: any = {
      inventoryItem: invId,
      quantityRemaining: { $gt: 0 },
    };
    if (searchPreferred) {
      layerQuery.purchase = { $in: preferredOids };
    }

    let layerQueryExec = StockLayer.findOne(layerQuery).sort({ receivedAt: 1, _id: 1 });
    if (session) layerQueryExec = layerQueryExec.session(session);
    const layerRaw = await layerQueryExec.lean();
    const layer = layerRaw as unknown as {
      _id: mongoose.Types.ObjectId;
      quantityRemaining: number;
      unitCost: number;
    } | null;

    if (!layer) {
      if (searchPreferred) {
        searchPreferred = false;
        continue;
      }
      let invQuery = Inventory.findById(invId).select("name currentStock reservedStock");
      if (session) invQuery = invQuery.session(session);
      const inv = await invQuery.lean();
      let layerQueryExec = StockLayer.find({ inventoryItem: invId, quantityRemaining: { $gt: 0 } }).select("quantityRemaining");
      if (session) layerQueryExec = layerQueryExec.session(session);
      const openLayers = await layerQueryExec.lean();
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

    const updateLayerOptions: any = { new: true };
    if (session) updateLayerOptions.session = session;
    const updated = await StockLayer.findOneAndUpdate(
      { _id: layer._id, quantityRemaining: { $gte: take } },
      { $inc: { quantityRemaining: -take } },
      updateLayerOptions
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

  const updateOptions: any = { new: true };
  if (session) updateOptions.session = session;
  const invUpdated = await Inventory.findOneAndUpdate(
    inventoryGuard,
    { $inc: { currentStock: -quantity, reservedStock: -releaseReserved } },
    updateOptions
  ).lean();

  if (!invUpdated) {
    let invQuery = Inventory.findById(invId).select("name currentStock reservedStock");
    if (session) invQuery = invQuery.session(session);
    const inv = await invQuery.lean();
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
