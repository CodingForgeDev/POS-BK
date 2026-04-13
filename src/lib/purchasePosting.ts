import mongoose, { ClientSession } from "mongoose";
import Purchase from "../models/Purchase";
import StockLayer from "../models/StockLayer";
import Inventory from "../models/Inventory";
import Supplier from "../models/Supplier";

export function weightedAverageCost(currentStock: number, currentCostPerUnit: number, addQty: number, addUnitCost: number): number {
  const cs = Math.max(0, Number(currentStock) || 0);
  const add = Math.max(0, Number(addQty) || 0);
  const newStock = cs + add;
  if (newStock <= 0) return Math.max(0, Number(addUnitCost) || 0);
  return (cs * (Number(currentCostPerUnit) || 0) + add * (Number(addUnitCost) || 0)) / newStock;
}

export type PostPurchaseLineInput = {
  inventoryItem: string;
  quantity: number;
  unitCost: number;
  packSize?: number | null;
  notes?: string;
};

export async function postPurchaseInSession(
  session: ClientSession,
  input: {
    supplierId?: string | null;
    referenceNumber?: string;
    receivedAt: Date;
    notes?: string;
    lines: PostPurchaseLineInput[];
    userId: string;
  }
): Promise<{ purchase: unknown }> {
  const { supplierId, referenceNumber, receivedAt, notes, lines, userId } = input;
  if (!lines?.length) {
    throw new Error("NO_LINES");
  }

  let supplierDoc: { name?: string } | null = null;
  if (supplierId) {
    supplierDoc = (await Supplier.findById(supplierId).session(session).lean()) as { name?: string } | null;
    if (!supplierDoc) {
      throw new Error("SUPPLIER_NOT_FOUND");
    }
  }

  const normalized = lines.map((l) => ({
    inventoryItem: new mongoose.Types.ObjectId(l.inventoryItem),
    quantity: Number(l.quantity),
    unitCost: Number(l.unitCost),
    packSize: l.packSize ?? null,
    notes: l.notes ?? "",
  }));

  for (const l of normalized) {
    if (!(l.quantity > 0)) {
      throw new Error("INVALID_QUANTITY");
    }
    if (l.unitCost < 0) {
      throw new Error("INVALID_COST");
    }
    const inv = await Inventory.findOne({ _id: l.inventoryItem, isActive: true }).session(session).lean();
    if (!inv) {
      throw new Error(`INVENTORY_NOT_FOUND:${l.inventoryItem}`);
    }
  }

  const totalAmount = normalized.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  const [purchaseDoc] = await Purchase.create(
    [
      {
        supplier: supplierId ? new mongoose.Types.ObjectId(supplierId) : null,
        referenceNumber: referenceNumber ?? "",
        receivedAt,
        lines: normalized,
        totalAmount,
        notes: notes ?? "",
        createdBy: new mongoose.Types.ObjectId(userId),
        status: "posted",
      },
    ],
    { session }
  );

  const supplierOid = supplierId ? new mongoose.Types.ObjectId(supplierId) : null;
  const supplierNameStr = supplierDoc?.name ?? "";

  for (let i = 0; i < normalized.length; i++) {
    const l = normalized[i];
    const inv = await Inventory.findById(l.inventoryItem).session(session);
    if (!inv) {
      throw new Error("INVENTORY_NOT_FOUND");
    }

    const oldStock = Number(inv.currentStock) || 0;
    const oldCost = Number(inv.costPerUnit) || 0;
    const newCost = weightedAverageCost(oldStock, oldCost, l.quantity, l.unitCost);

    await StockLayer.create(
      [
        {
          sourceType: "purchase",
          purchase: purchaseDoc._id,
          lineIndex: i,
          inventoryItem: l.inventoryItem,
          supplier: supplierOid,
          receivedAt,
          quantityOriginal: l.quantity,
          quantityRemaining: l.quantity,
          unitCost: l.unitCost,
        },
      ],
      { session }
    );

    const $set: Record<string, unknown> = {
      costPerUnit: newCost,
      lastRestockedAt: receivedAt,
      lastRestockedBy: new mongoose.Types.ObjectId(userId),
    };
    if (supplierOid && !inv.supplier) {
      $set.supplier = supplierOid;
      $set.supplierName = supplierNameStr;
    }

    await Inventory.updateOne({ _id: l.inventoryItem }, { $inc: { currentStock: l.quantity }, $set }, { session });
  }

  return { purchase: purchaseDoc.toObject() };
}

export async function postAdjustmentLayerInSession(
  session: ClientSession,
  input: {
    inventoryItemId: string;
    quantity: number;
    unitCost: number;
    userId: string;
  }
): Promise<void> {
  const { inventoryItemId, quantity, unitCost, userId } = input;
  if (!(quantity > 0)) {
    throw new Error("INVALID_QUANTITY");
  }
  if (unitCost < 0) {
    throw new Error("INVALID_COST");
  }

  const invId = new mongoose.Types.ObjectId(inventoryItemId);
  const inv = await Inventory.findOne({ _id: invId, isActive: true }).session(session);
  if (!inv) {
    throw new Error("INVENTORY_NOT_FOUND");
  }

  const receivedAt = new Date();
  const oldStock = Number(inv.currentStock) || 0;
  const oldCost = Number(inv.costPerUnit) || 0;
  const newCost = weightedAverageCost(oldStock, oldCost, quantity, unitCost);

  await StockLayer.create(
    [
      {
        sourceType: "adjustment",
        purchase: null,
        lineIndex: 0,
        inventoryItem: invId,
        supplier: null,
        receivedAt,
        quantityOriginal: quantity,
        quantityRemaining: quantity,
        unitCost,
      },
    ],
    { session }
  );

  await Inventory.updateOne(
    { _id: invId },
    {
      $inc: { currentStock: quantity },
      $set: {
        costPerUnit: newCost,
        lastRestockedAt: receivedAt,
        lastRestockedBy: new mongoose.Types.ObjectId(userId),
      },
    },
    { session }
  );
}
