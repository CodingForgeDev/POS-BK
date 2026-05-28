import { Response } from "express";
import mongoose from "mongoose";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import { AuthenticatedRequest } from "../middleware/auth";
import BOMTransaction from "../models/bom-transaction.model";
import Inventory from "../models/Inventory";
import StockLayer from "../models/StockLayer";
import Product from "../models/Product";

const BOMTransactionModel = BOMTransaction as mongoose.Model<any, any>;
import { deductInventoryFifo } from "../lib/inventoryFifo";
import { createJournalEntryRecord, findLedgerAccountByFallback } from "../lib/journalPosting";
import { InsufficientStockError } from "../lib/inventoryErrors";

async function findInventoryItem(id: string, session: mongoose.ClientSession | null = null) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const query = Inventory.findById(new mongoose.Types.ObjectId(id));
  if (session) query.session(session);
  return query.lean();
}

function getRawAmount(raw: any) {
  const quantity = Number(raw.quantity || 0);
  const rate = Number(raw.rate || 0);
  return raw.amount != null ? Number(raw.amount) : Number(quantity * rate);
}

function isValidRawLine(raw: any) {
  const inventoryId = String(raw.inventoryItem || raw.inventoryItemId || "");
  return mongoose.Types.ObjectId.isValid(inventoryId) && Number(raw.quantity || 0) > 0 && getRawAmount(raw) > 0;
}

function getProducedValue(item: any) {
  const quantity = Number(item.quantity || 0);
  if (quantity <= 0) return 0;
  const amount = Number(item.amount || 0);
  if (amount > 0) return amount;
  const costPerUnit = Number(item.costPerUnit || 0);
  return Number(costPerUnit * quantity);
}

function isValidProducedLine(item: any) {
  const inventoryId = String(item.inventoryItem || item.linkedReadyInventory || "");
  return mongoose.Types.ObjectId.isValid(inventoryId) && Number(item.quantity || 0) > 0 && getProducedValue(item) > 0;
}

function getValidRawMaterials(rawMaterials: any[] = []) {
  return (rawMaterials || []).filter(isValidRawLine);
}

function getValidFinishedItems(bom: any) {
  const finishedItems = (bom.producedItems?.length ? bom.producedItems : bom.producedMenuItems) || [];
  return finishedItems.filter(isValidProducedLine);
}

function normalizeText(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeLookupKey(raw: unknown): string {
  return normalizeText(raw).replace(/^ready-/, "").replace(/[^a-z0-9]+/g, "");
}

function doesMenuProductMatchReadyInventory(menuProduct: any, readyInv: any): boolean {
  const menuSku = normalizeLookupKey(menuProduct.sku);
  const menuName = normalizeLookupKey(menuProduct.name);
  const invSku = normalizeLookupKey(readyInv.sku);
  const invName = normalizeLookupKey(readyInv.name);

  if (menuSku && invSku && menuSku === invSku) return true;
  if (menuName && invName && menuName === invName) return true;
  if (menuSku && invName && menuSku === invName) return true;
  if (menuName && invSku && menuName === invSku) return true;
  return false;
}

async function validateReadyInventoryLinkages(
  bom: any,
  session: mongoose.ClientSession | null
): Promise<void> {
  const finishedItems = getValidFinishedItems(bom);
  const menuProductIds = new Set<string>();
  const readyInventoryIds = new Set<string>();

  for (const item of finishedItems) {
    const menuProductId = String(item.menuProductId || "").trim();
    const readyInventoryId = String(item.linkedReadyInventory || item.inventoryItem || "").trim();
    if (menuProductId) menuProductIds.add(menuProductId);
    if (readyInventoryId) readyInventoryIds.add(readyInventoryId);
  }

  if (!menuProductIds.size || !readyInventoryIds.size) {
    return;
  }

  const products = await Product.find({ _id: { $in: Array.from(menuProductIds) } })
    .select("sku name")
    .lean();
  const inventories = await Inventory.find({
    _id: { $in: Array.from(readyInventoryIds) },
    isActive: true,
  })
    .select("sku name inventoryType isForReadyMenu")
    .lean();

  const productMap = new Map(products.map((product: any) => [String(product._id), product]));
  const inventoryMap = new Map(inventories.map((inv: any) => [String(inv._id), inv]));

  for (const item of finishedItems) {
    const menuProductId = String(item.menuProductId || "").trim();
    const readyInventoryId = String(item.linkedReadyInventory || item.inventoryItem || "").trim();
    if (!menuProductId || !readyInventoryId) continue;

    const menuProduct = productMap.get(menuProductId);
    const readyInv = inventoryMap.get(readyInventoryId);
    if (!menuProduct || !readyInv) {
      throw new Error("Invalid menu product or ready inventory selection.");
    }

    if (readyInv.inventoryType !== "ready" && !readyInv.isForReadyMenu) {
      throw new Error(`Selected inventory item "${readyInv.name}" is not valid ready stock for menu product "${menuProduct.name}".`);
    }

    if (!doesMenuProductMatchReadyInventory(menuProduct, readyInv)) {
      throw new Error(`Ready inventory "${readyInv.name}" does not match menu product "${menuProduct.name}". Choose the ready stock item that matches this menu item.`);
    }
  }
}

function sanitizeBomPayload(payload: any) {
  const rawMaterials = getValidRawMaterials(payload.rawMaterials || []);
  const finishedItems = getValidFinishedItems(payload);
  return {
    ...payload,
    rawMaterials,
    producedItems: payload.producedItems?.length ? finishedItems : undefined,
    producedMenuItems: payload.producedItems?.length ? undefined : finishedItems,
  };
}

async function buildProductionJournal(bom: any, session: mongoose.ClientSession | null = null) {
  const rawInventoryAccount = await findLedgerAccountByFallback(
    { type: "asset", subcategory: "inventory" },
    { title: /raw material inventory|inventory|stock/i },
    { type: "asset" }
  );
  const finishedGoodsAccount = await findLedgerAccountByFallback(
    { type: "asset", subcategory: "inventory" },
    { title: /finished goods|inventory|stock/i },
    { type: "asset" }
  );
  const wipAccount = await findLedgerAccountByFallback(
    { type: "expense", title: /work in progress|wip|production/i },
    { type: "expense", title: /production|manufacturing/i },
    { type: "expense" }
  );
  const varianceFavourable = await findLedgerAccountByFallback(
    { type: "revenue", title: /variance|production variance|manufacturing variance/i },
    { type: "revenue" }
  );
  const varianceUnfavourable = await findLedgerAccountByFallback(
    { type: "expense", title: /variance|production variance|manufacturing variance/i },
    { type: "expense" }
  );

  if (!rawInventoryAccount || !finishedGoodsAccount || !wipAccount) {
    throw new Error("Unable to resolve production ledger accounts. Please configure inventory and production accounts.");
  }

  const lines: any[] = [];
  const rawMaterials = getValidRawMaterials(bom.rawMaterials || []);
  const totalRawCost = Number(rawMaterials.reduce((sum: number, raw: any) => sum + getRawAmount(raw), 0).toFixed(2));
  const finishedItems = getValidFinishedItems(bom);

  for (const raw of rawMaterials) {
    const rawAmount = getRawAmount(raw);
    lines.push({
      account: wipAccount._id,
      accountName: wipAccount.title,
      debit: rawAmount,
      credit: 0,
      note: `Consume raw material ${raw.itemName}`,
    });
    lines.push({
      account: rawInventoryAccount._id,
      accountName: rawInventoryAccount.title,
      debit: 0,
      credit: rawAmount,
      note: `Raw material inventory reduction ${raw.itemName}`,
    });
  }

  const totalProducedValue = Number(
    finishedItems.reduce((sum: number, item: any) => {
      return sum + getProducedValue(item);
    }, 0).toFixed(2)
  );

  if (totalProducedValue <= 0) {
    throw new Error("Unable to compute finished goods value for BOM. Verify produced item amounts or finished item cost.");
  }

  lines.push({
    account: finishedGoodsAccount._id,
    accountName: finishedGoodsAccount.title,
    debit: totalProducedValue,
    credit: 0,
    note: `Finished goods production ${bom.transactionNo}`,
  });
  lines.push({
    account: wipAccount._id,
    accountName: wipAccount.title,
    debit: 0,
    credit: totalProducedValue,
    note: `Transfer production cost to finished goods ${bom.transactionNo}`,
  });

  const varianceAmount = Number(bom.variance || 0);
  if (Math.abs(varianceAmount) > 0.001) {
    if (varianceAmount > 0) {
      if (!varianceFavourable) {
        throw new Error("Unable to resolve variance account.");
      }
      lines.push({
        account: wipAccount._id,
        accountName: wipAccount.title,
        debit: varianceAmount,
        credit: 0,
        note: `Production variance adjustment ${bom.transactionNo}`,
      });
      lines.push({
        account: varianceFavourable._id,
        accountName: varianceFavourable.title,
        debit: 0,
        credit: varianceAmount,
        note: `Favourable production variance ${bom.transactionNo}`,
      });
    } else {
      if (!varianceUnfavourable) {
        throw new Error("Unable to resolve variance account.");
      }
      const unfavorableAmount = Math.abs(varianceAmount);
      lines.push({
        account: varianceUnfavourable._id,
        accountName: varianceUnfavourable.title,
        debit: unfavorableAmount,
        credit: 0,
        note: `Unfavourable production variance ${bom.transactionNo}`,
      });
      lines.push({
        account: wipAccount._id,
        accountName: wipAccount.title,
        debit: 0,
        credit: unfavorableAmount,
        note: `Production variance adjustment ${bom.transactionNo}`,
      });
    }
  }

  try {
    return createJournalEntryRecord({
      date: bom.date || new Date(),
      reference: `BOM-${bom.transactionNo}`,
      description: `Production BOM ${bom.transactionNo}`,
      lines,
      source: "MANUAL",
      sourceId: bom._id || null,
      postedBy: bom.postedBy || null,
      status: "posted",
      session,
    });
  } catch (error: any) {
    console.error("Production journal creation failed", {
      bomId: String(bom._id),
      transactionNo: bom.transactionNo,
      totalRawCost,
      totalProducedValue,
      variance: bom.variance,
      lines,
      error: error?.message || error,
    });
    throw new Error(`Production journal failed: ${error?.message || "unknown error"}`);
  }
}

async function applyInventoryChanges(
  bom: any,
  session: mongoose.ClientSession | null,
  direction: 1 | -1
) {
  // For reversals, use a looser filter: just need a valid inventory ID and qty > 0.
  // The strict cost/amount check in isValidProducedLine is only meaningful for forward production.
  let rawMaterials: any[];
  let finishedItems: any[];

  if (direction === 1) {
    rawMaterials  = getValidRawMaterials(bom.rawMaterials || []);
    finishedItems = getValidFinishedItems(bom);
  } else {
    rawMaterials = (bom.rawMaterials || []).filter((r: any) => {
      const id = String(r.inventoryItem || r.inventoryItemId || "");
      return mongoose.Types.ObjectId.isValid(id) && Number(r.quantity || 0) > 0;
    });
    const allProduced = (bom.producedItems?.length ? bom.producedItems : bom.producedMenuItems) || [];
    finishedItems = allProduced.filter((item: any) => {
      const id = String(item.inventoryItem || item.linkedReadyInventory || "");
      return mongoose.Types.ObjectId.isValid(id) && Number(item.quantity || 0) > 0;
    });
  }

  if (!rawMaterials.length || !finishedItems.length) {
    throw new Error("BOM transaction must contain valid raw materials and produced items.");
  }

  const totalProducedQuantity = finishedItems.reduce(
    (sum: number, item: any) => sum + Number(item.quantity || 0),
    0
  );
  if (totalProducedQuantity <= 0) {
    throw new Error("Total produced quantity must be greater than zero.");
  }

  let rawMaterialsConsumed = 0;
  let readyItemsProduced   = 0;
  const txNo = bom.transactionNo || "";

  // ── Raw materials ───────────────────────────────────────────────────────
  for (const raw of rawMaterials) {
    const consumedQty = Number(raw.quantity || 0);
    if (!(consumedQty > 0)) continue;

    if (direction === 1) {
      // Deduct via FIFO — creates a StockLayer with sourceType "production", adjustmentType "remove"
      await deductInventoryFifo({
        inventoryItemId: String(raw.inventoryItem),
        quantity:        consumedQty,
        session,
        releaseReserved: 0,
        createTrackingLayer: {
          sourceType:       "production",
          adjustmentType:   "remove",
          actionLabel:      `Consumed in production: ${raw.itemName || raw.itemCode || "raw material"}${txNo ? ` — ${txNo}` : ""}`,
          bomTransactionNo: txNo || null,
          createdBy:        bom.postedBy || bom.createdBy || null,
        },
      });
    } else {
      // Reversal: return raw material stock
      const inventoryObjectId = new mongoose.Types.ObjectId(String(raw.inventoryItem));
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { _id: inventoryObjectId, isActive: true } as any,
        { $inc: { currentStock: consumedQty } },
        { new: true, session }
      ).lean();
      if (!inventoryUpdate) {
        throw new Error("Raw inventory item not found for reversal.");
      }
      await StockLayer.create(
        [{
          sourceType:       "adjustment",
          adjustmentType:   "add",
          actionLabel:      `Production reversal (raw): ${raw.itemName || ""}${txNo ? ` — ${txNo}` : ""}`,
          bomTransactionNo: txNo || null,
          purchase:         null,
          lineIndex:        0,
          inventoryItem:    inventoryObjectId,
          supplier:         null,
          createdBy:        bom.postedBy || bom.createdBy || null,
          receivedAt:       new Date(),
          quantityOriginal: consumedQty,
          quantityRemaining: consumedQty,
          unitCost:         Number(raw.rate || 0),
        }],
        session ? { session } : undefined
      );
    }

    rawMaterialsConsumed += consumedQty;
  }

  // ── Finished / ready items ──────────────────────────────────────────────────
  for (const finished of finishedItems) {
    const inventoryId = String(finished.inventoryItem || finished.linkedReadyInventory || "");
    if (!mongoose.Types.ObjectId.isValid(inventoryId)) {
      throw new Error("Invalid ready inventory link for produced item.");
    }
    const inventoryObjectId = new mongoose.Types.ObjectId(inventoryId);
    const quantity = Number(finished.quantity || 0);
    if (!(quantity > 0)) continue;

    const updateData: any = { $inc: { currentStock: direction * quantity } };
    if (direction === 1) {
      updateData.$set = {
        costPerUnit:   finished.rate || bom.costPerUnit || 0,
        inventoryType: "ready",
      };
    }

    const inventoryUpdate = await Inventory.findOneAndUpdate(
      {
        _id: inventoryObjectId,
        isActive: true,
        currentStock: direction === -1 ? { $gte: quantity } : { $exists: true },
      } as any,
      updateData,
      { new: true, session }
    ).lean();

    if (!inventoryUpdate) {
      throw new InsufficientStockError([{
        inventoryId,
        name:      finished.itemName || finished.menuProductName || "Ready inventory item",
        required:  quantity,
        available: 0,
      }]);
    }

    const inventoryName = (inventoryUpdate as any).name || finished.menuProductName || "Ready Item";

    await StockLayer.create(
      [{
        sourceType:       direction === 1 ? "production" : "adjustment",
        adjustmentType:   direction === 1 ? "add"        : "remove",
        actionLabel:      direction === 1
          ? `Produced: ${inventoryName}${txNo ? ` — ${txNo}` : ""}`
          : `Production reversal (ready): ${inventoryName}${txNo ? ` — ${txNo}` : ""}`,
        bomTransactionNo: txNo || null,
        purchase:         null,
        lineIndex:        0,
        inventoryItem:    inventoryObjectId,
        supplier:         null,
        createdBy:        bom.postedBy || bom.createdBy || null,
        receivedAt:       new Date(),
        quantityOriginal: quantity,
        quantityRemaining: direction === 1 ? quantity : 0,
        unitCost:         finished.rate || bom.costPerUnit || 0,
      }],
      session ? { session } : undefined
    );

    readyItemsProduced += quantity;
  }

  return { rawMaterialsConsumed, readyItemsProduced };
}

export const createBOM = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const payload = sanitizeBomPayload(req.body);
    const bom = new BOMTransaction({
      ...payload,
      status: "draft",
      createdBy: new mongoose.Types.ObjectId(req.user._id),
    });
    await bom.save();
    return sendSuccess(res, bom, "BOM draft created", 201);
  } catch (error: any) {
    return sendError(res, error.message || "Failed to create BOM", 500);
  }
};

export const getAllBOMs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { page = "1", limit = "20", status, search, startDate, endDate } = req.query as Record<string, string>;
    const query: any = {};
    if (status) query.status = status;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }
    if (search) {
      query.$or = [
        { transactionNo: { $regex: search, $options: "i" } },
        { referenceNo: { $regex: search, $options: "i" } },
        { remarks: { $regex: search, $options: "i" } },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      BOMTransactionModel.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      BOMTransactionModel.countDocuments(query),
    ]);
    return sendSuccess(res, { data, pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) } });
  } catch (error: any) {
    return sendError(res, error.message || "Failed to fetch BOMs", 500);
  }
};

export const getBOMById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const bom = await BOMTransactionModel.findById(req.params.id).lean();
    if (!bom) {
      return sendError(res, "BOM not found", 404);
    }
    return sendSuccess(res, bom);
  } catch (error: any) {
    return sendError(res, error.message || "Failed to fetch BOM", 500);
  }
};

export const updateBOM = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const bom = await BOMTransactionModel.findById(req.params.id);
    if (!bom) return sendError(res, "BOM not found", 404);
    if (bom.status !== "draft") {
      return sendError(res, "Only draft BOMs can be updated", 400);
    }
    const payload = sanitizeBomPayload(req.body);
    const allowed = ["date", "referenceNo", "remarks", "rawMaterials", "producedItems", "producedMenuItems"];
    for (const key of allowed) {
      if (payload[key] !== undefined) {
        (bom as any)[key] = payload[key];
      }
    }
    bom.updatedBy = new mongoose.Types.ObjectId(req.user._id);
    await bom.save();
    return sendSuccess(res, bom, "BOM updated");
  } catch (error: any) {
    return sendError(res, error.message || "Failed to update BOM", 500);
  }
};

function isTransactionUnavailableError(error: any): boolean {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("transaction numbers are only allowed on a replica set member or mongos") ||
         message.includes("transactions unavailable") ||
         /starttransaction.*not supported/i.test(message);
}

const runPostBOM = async (req: AuthenticatedRequest, res: Response, session: mongoose.ClientSession | null) => {
  const bomQuery = BOMTransactionModel.findById(req.params.id);
  if (session) bomQuery.session(session);
  const bom = await bomQuery;
  if (!bom) return sendError(res, "BOM not found", 404);
  if (bom.status !== "draft") {
    return sendError(res, "Only draft BOMs can be posted", 400);
  }
  const finishedItems = (bom.producedItems?.length ? bom.producedItems : bom.producedMenuItems) || [];
  if (!bom.rawMaterials.length || !finishedItems.length) {
    return sendError(res, "BOM must include raw materials and produced items", 400);
  }

  const validRawMaterials = getValidRawMaterials(bom.rawMaterials || []);
  const validFinishedItems = getValidFinishedItems(bom);
  if (!validRawMaterials.length || !validFinishedItems.length) {
    return sendError(res, "BOM contains invalid or empty production lines.", 400);
  }

  bom.rawMaterials = validRawMaterials;
  if (bom.producedItems?.length) {
    bom.producedItems = validFinishedItems;
  } else {
    bom.producedMenuItems = validFinishedItems;
  }

  await validateReadyInventoryLinkages(bom, session);

  let summary;
  let inventoryApplied = false;

  try {
    summary = await applyInventoryChanges(bom, session, 1);
    inventoryApplied = true;
    const journal = await buildProductionJournal(bom, session);
    bom.journalEntryId = journal._id;
    bom.status = "posted";
    bom.postedBy = new mongoose.Types.ObjectId(req.user._id);
    if (session) {
      await bom.save({ session });
    } else {
      await bom.save();
    }
    return sendSuccess(res, { bom, summary }, "BOM posted successfully");
  } catch (error: any) {
    if (inventoryApplied && !session) {
      try {
        await applyInventoryChanges(bom, null, -1);
      } catch (rollbackError) {
        console.error("Failed to rollback inventory after BOM post failure", rollbackError);
      }
    }
    throw error;
  }
};

function inventoryLinesEqual(
  aRaw: any[], bRaw: any[],
  aProduced: any[], bProduced: any[]
): boolean {
  const normRaw = (items: any[]) =>
    getValidRawMaterials(items)
      .map((r) => ({ id: String(r.inventoryItem || ""), qty: Number(r.quantity || 0) }))
      .sort((x, y) => x.id.localeCompare(y.id));
  const normProduced = (items: any[]) =>
    items.filter(isValidProducedLine)
      .map((r) => ({ id: String(r.inventoryItem || r.linkedReadyInventory || ""), qty: Number(r.quantity || 0) }))
      .sort((x, y) => x.id.localeCompare(y.id));

  const ra = normRaw(aRaw), rb = normRaw(bRaw);
  const pa = normProduced(aProduced), pb = normProduced(bProduced);
  if (ra.length !== rb.length || pa.length !== pb.length) return false;
  return (
    ra.every((x, i) => x.id === rb[i].id && Math.abs(x.qty - rb[i].qty) < 0.001) &&
    pa.every((x, i) => x.id === pb[i].id && Math.abs(x.qty - pb[i].qty) < 0.001)
  );
}

const runReapplyBOM = async (req: AuthenticatedRequest, res: Response, session: mongoose.ClientSession | null) => {
  const bomQuery = BOMTransactionModel.findById(req.params.id);
  if (session) bomQuery.session(session);
  const bom = await bomQuery;
  if (!bom) return sendError(res, "BOM not found", 404);
  if (bom.status !== "posted") {
    return sendError(res, "Only posted BOMs can be reapplied", 400);
  }

  const originalBom = JSON.parse(JSON.stringify(bom.toObject()));
  const payload = sanitizeBomPayload(req.body);
  const allowed = ["date", "referenceNo", "remarks", "rawMaterials", "producedItems", "producedMenuItems"];

  // If quantities/items are unchanged, skip the expensive reverse+reapply cycle
  const newProduced = getValidFinishedItems(payload);
  const oldProduced = getValidFinishedItems(bom);
  if (inventoryLinesEqual(payload.rawMaterials || [], bom.rawMaterials || [], newProduced, oldProduced)) {
    for (const key of ["date", "referenceNo", "remarks"] as const) {
      if (payload[key] !== undefined) (bom as any)[key] = payload[key];
    }
    bom.updatedBy = new mongoose.Types.ObjectId(req.user._id);
    if (session) {
      await bom.save({ session });
    } else {
      await bom.save();
    }
    return sendSuccess(res, { bom, summary: { rawMaterialsConsumed: 0, readyItemsProduced: 0 } }, "BOM updated");
  }

  await applyInventoryChanges(bom, session, -1);
  bom.status = "draft";
  bom.postedBy = null;
  bom.journalEntryId = null;
  bom.reversedBy = null;
  bom.reversalNote = "";
  bom.updatedBy = new mongoose.Types.ObjectId(req.user._id);

  for (const key of allowed) {
    if (payload[key] !== undefined) {
      (bom as any)[key] = payload[key];
    }
  }

  if (session) {
    await bom.save({ session });
  } else {
    await bom.save();
  }

  try {
    return await runPostBOM(req, res, session);
  } catch (error: any) {
    if (!session) {
      try {
        bom.status = originalBom.status;
        bom.postedBy = originalBom.postedBy;
        bom.journalEntryId = originalBom.journalEntryId;
        bom.updatedBy = originalBom.updatedBy;
        bom.reversedBy = originalBom.reversedBy;
        bom.reversalNote = originalBom.reversalNote;
        bom.rawMaterials = originalBom.rawMaterials;
        bom.producedItems = originalBom.producedItems;
        bom.producedMenuItems = originalBom.producedMenuItems;
        if (bom.status === "draft") {
          await bom.save();
        } else {
          await bom.save();
        }
        await applyInventoryChanges(originalBom, null, 1);
      } catch (restoreError: any) {
        console.error("Failed to restore BOM inventory after reapply failure", restoreError);
      }
    }
    throw error;
  }
};

export const reapplyBOM = async (req: AuthenticatedRequest, res: Response) => {
  await connectDB();
  const session = await mongoose.startSession();
  let sessionEnded = false;

  try {
    try {
      await session.startTransaction();
      const result = await runReapplyBOM(req, res, session);
      await session.commitTransaction();
      await session.endSession();
      sessionEnded = true;
      return result;
    } catch (txnError: any) {
      if (isTransactionUnavailableError(txnError)) {
        session.endSession();
        sessionEnded = true;
        return await runReapplyBOM(req, res, null);
      }
      throw txnError;
    }
  } catch (error: any) {
    console.error("reapplyBOM error:", error);
    if (error instanceof InsufficientStockError) {
      return sendError(res, error.message, 400, error.shortages);
    }
    return sendError(res, error.message || "Failed to reapply BOM", 500);
  } finally {
    if (!sessionEnded) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
      session.endSession();
    }
  }
};

export const postBOM = async (req: AuthenticatedRequest, res: Response) => {
  await connectDB();
  
  // Try with transaction first (if replica set available)
  const session = await mongoose.startSession();
  let sessionEnded = false;
  
  try {
    try {
      await session.startTransaction();
      const result = await runPostBOM(req, res, session);
      await session.commitTransaction();
      await session.endSession();
      sessionEnded = true;
      return result;
    } catch (txnError: any) {
      // If transaction not supported, retry without session
      if (isTransactionUnavailableError(txnError)) {
        session.endSession();
        sessionEnded = true;
        return await runPostBOM(req, res, null);
      }
      throw txnError;
    }
  } catch (error: any) {
    console.error("postBOM error:", error);
    
    if (error instanceof InsufficientStockError) {
      return sendError(res, error.message, 400, error.shortages);
    }
    return sendError(res, error.message || "Failed to post BOM", 500);
  } finally {
    if (!sessionEnded) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
      session.endSession();
    }
  }
};

const runReverseBOM = async (req: AuthenticatedRequest, res: Response, session: mongoose.ClientSession | null) => {
  const bomQuery = BOMTransactionModel.findById(req.params.id);
  if (session) bomQuery.session(session);
  const bom = await bomQuery;
  if (!bom) return sendError(res, "BOM not found", 404);
  if (bom.status !== "posted") {
    return sendError(res, "Only posted BOMs can be reversed", 400);
  }

  await applyInventoryChanges(bom, session, -1);
  bom.status = "reversed";
  bom.reversedBy = new mongoose.Types.ObjectId(req.user._id);
  bom.reversalNote = String(req.body.reason || req.body.reversalNote || "").trim();
  if (session) {
    await bom.save({ session });
  } else {
    await bom.save();
  }
  return sendSuccess(res, bom, "BOM reversed successfully");
};

export const reverseBOM = async (req: AuthenticatedRequest, res: Response) => {
  await connectDB();
  
  // Try with transaction first (if replica set available)
  const session = await mongoose.startSession();
  let sessionEnded = false;
  
  try {
    try {
      await session.startTransaction();
      const result = await runReverseBOM(req, res, session);
      await session.commitTransaction();
      await session.endSession();
      sessionEnded = true;
      return result;
    } catch (txnError: any) {
      // If transaction not supported, retry without session
      if (isTransactionUnavailableError(txnError)) {
        session.endSession();
        sessionEnded = true;
        return await runReverseBOM(req, res, null);
      }
      throw txnError;
    }
  } catch (error: any) {
    console.error("reverseBOM error:", error);
    
    if (error instanceof InsufficientStockError) {
      return sendError(res, error.message, 400, error.shortages);
    }
    return sendError(res, error.message || "Failed to reverse BOM", 500);
  } finally {
    if (!sessionEnded) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
      session.endSession();
    }
  }
};

// ─── Helper Functions for One-Click Production ────────────────────────────

/**
 * Auto-creates ready inventory item if it doesn't exist for the produced menu item.
 * Returns the inventory _id (either existing or newly created).
 */
async function autoCreateReadyInventory(
  menuProduct: any,
  session: mongoose.ClientSession | null
): Promise<string> {
  // Check if ready inventory already exists by SKU, name, or isForReadyMenu flag
  // Priority: 1. SKU match, 2. Name match, 3. isForReadyMenu flag
  let existingInventory = null;

  // First, try to find by SKU if available
  if (menuProduct.sku) {
    const query = Inventory.findOne({
      $and: [
        { isActive: true },
        { inventoryType: "ready" },
        {
          sku: {
            $regex: `^${menuProduct.sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            $options: "i",
          },
        },
      ],
    });
    if (session) query.session(session);
    existingInventory = await query.lean();
  }

  // If not found by SKU, try by name
  if (!existingInventory) {
    const query = Inventory.findOne({
      $and: [
        { isActive: true },
        { inventoryType: "ready" },
        { isForReadyMenu: true },
        {
          name: {
            $regex: `^${menuProduct.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            $options: "i",
          },
        },
      ],
    });
    if (session) query.session(session);
    existingInventory = await query.lean();
  }

  if (existingInventory) {
    return String((existingInventory as any)._id);
  }

  // Auto-create new ready inventory item using menu product name as SKU base
  // This ensures consistency - same menu product = same ready inventory
  const baseSkuName = menuProduct.sku || menuProduct.name.replace(/\s+/g, "-").toUpperCase();
  const readyInventory = new Inventory({
    name: menuProduct.name,
    sku: `READY-${baseSkuName}`,
    unit: menuProduct.unit || "Unit",
    inventoryType: "ready",
    currentStock: 0,
    costPerUnit: 0,
    isForReadyMenu: true,
    isActive: true,
    createdBy: menuProduct.createdBy || null,
  });

  if (session) {
    await readyInventory.save({ session });
  } else {
    await readyInventory.save();
  }

  return String(readyInventory._id);
}

/**
 * Auto-populates the menu item's recipe with consumed raw materials.
 * Creates recipeLines from the raw materials used in production.
 */
async function autoPopulateRecipe(
  menuProductId: string,
  rawMaterials: any[],
  totalProducedQty: number,
  session: mongoose.ClientSession | null
): Promise<void> {
  if (totalProducedQty <= 0 || !rawMaterials.length) {
    return;
  }

  // Map raw materials to recipe lines format
  const recipeLines = rawMaterials.map((raw) => ({
    inventoryItem: new mongoose.Types.ObjectId(String(raw.inventoryItem || raw.inventoryItemId)),
    quantityPerUnit: Number((Number(raw.quantity || 0) / totalProducedQty).toFixed(4)),
    unit: raw.unit || "Unit",
  }));

  const query = Product.findByIdAndUpdate(
    new mongoose.Types.ObjectId(menuProductId),
    {
      $set: {
        recipeLines,
        isReadyItem: true,
      },
    },
    { new: true }
  );

  if (session) {
    query.session(session);
  }

  await query;
}

// ─── One-Click Production Endpoint ───────────────────────────────────────

const runProduceNow = async (
  req: AuthenticatedRequest,
  res: Response,
  session: mongoose.ClientSession | null
) => {
  const payload = sanitizeBomPayload(req.body);
  const finishedItems = getValidFinishedItems(payload);

  if (!payload.rawMaterials.length || !finishedItems.length) {
    return sendError(res, "Must include raw materials and produced items", 400);
  }

  // Create BOM in draft first
  const bom = new BOMTransaction({
    ...payload,
    status: "draft",
    createdBy: new mongoose.Types.ObjectId(req.user._id),
  });

  if (session) {
    await bom.save({ session });
  } else {
    await bom.save();
  }

  let summary;
  let inventoryApplied = false;
  let readyInventoriesCreated: { menuProductId: string; inventoryId: string }[] = [];

  try {
    await validateReadyInventoryLinkages(bom, session);
    // Apply inventory changes (deduct raw, add ready)
    summary = await applyInventoryChanges(bom, session, 1);
    inventoryApplied = true;

    // Populate recipes for produced menu items only. Ready inventory must be selected explicitly.
    if (payload.producedMenuItems?.length) {
      const totalProducedQty = payload.producedMenuItems.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0);

      for (const menuItem of payload.producedMenuItems) {
        try {
          if (!menuItem.menuProductId) continue;
          await autoPopulateRecipe(String(menuItem.menuProductId), payload.rawMaterials, totalProducedQty, session);
        } catch (err) {
          console.error(`Failed to auto-setup recipe for menu item ${menuItem.menuProductId}:`, err);
        }
      }

      bom.producedMenuItems = finishedItems;
    }

    // Create accounting journal entries
    const journal = await buildProductionJournal(bom, session);
    bom.journalEntryId = journal._id;

    // Mark as posted immediately
    bom.status = "posted";
    bom.postedBy = new mongoose.Types.ObjectId(req.user._id);

    if (session) {
      await bom.save({ session });
    } else {
      await bom.save();
    }

    return sendSuccess(
      res,
      {
        bom,
        summary,
        readyInventoriesCreated,
      },
      "Production completed successfully",
      201
    );
  } catch (error: any) {
    if (inventoryApplied && !session) {
      try {
        await applyInventoryChanges(bom, null, -1);
      } catch (rollbackError) {
        console.error("Failed to rollback inventory after produce-now failure", rollbackError);
      }
    }
    throw error;
  }
};

export const produceNow = async (req: AuthenticatedRequest, res: Response) => {
  await connectDB();

  // Try with transaction first (if replica set available)
  const session = await mongoose.startSession();
  let sessionEnded = false;

  try {
    try {
      await session.startTransaction();
      const result = await runProduceNow(req, res, session);
      await session.commitTransaction();
      await session.endSession();
      sessionEnded = true;
      return result;
    } catch (txnError: any) {
      // If transaction not supported, retry without session
      if (isTransactionUnavailableError(txnError)) {
        session.endSession();
        sessionEnded = true;
        return await runProduceNow(req, res, null);
      }
      throw txnError;
    }
  } catch (error: any) {
    console.error("produceNow error:", error);

    if (error instanceof InsufficientStockError) {
      return sendError(res, error.message, 400, error.shortages);
    }
    return sendError(res, error.message || "Failed to complete production", 500);
  } finally {
    if (!sessionEnded) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
      session.endSession();
    }
  }
};

export const deleteBOM = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const bom = await BOMTransactionModel.findById(req.params.id);
    if (!bom) return sendError(res, "BOM not found", 404);
    if (bom.status !== "draft") {
      return sendError(res, "Only draft BOMs can be deleted", 400);
    }
    await bom.deleteOne();
    return sendSuccess(res, null, "BOM draft deleted");
  } catch (error: any) {
    return sendError(res, error.message || "Failed to delete BOM", 500);
  }
};

/**
 * Duplicate recipe from one menu item to another with same raw materials
 * POST /bom/duplicate-recipe
 */
export const duplicateRecipe = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  
  try {
    await connectDB();
    const { sourceMenuProductId, targetMenuProductId, producedQuantity } = req.body;

    if (!sourceMenuProductId || !targetMenuProductId || !producedQuantity || producedQuantity <= 0) {
      return sendError(res, "sourceMenuProductId, targetMenuProductId, and producedQuantity are required", 400);
    }

    // Get source menu product with recipe
    const sourceProduct = (await Product.findById(sourceMenuProductId).lean()) as any;
    if (!sourceProduct) {
      return sendError(res, "Source menu product not found", 404);
    }

    if (!sourceProduct.recipeLines || sourceProduct.recipeLines.length === 0) {
      return sendError(res, "Source product has no recipe to duplicate", 400);
    }

    // Get target menu product
    const targetProduct = (await Product.findById(targetMenuProductId).lean()) as any;
    if (!targetProduct) {
      return sendError(res, "Target menu product not found", 404);
    }

    // Build raw materials from recipe (multiply by produced quantity)
    const rawMaterials = sourceProduct.recipeLines.map((recipeLine: any) => ({
      inventoryItem: recipeLine.inventoryItem,
      quantity: (recipeLine.quantityPerUnit || 0) * producedQuantity,
      unit: recipeLine.unit || "Unit",
    }));

    // Create ready inventory for target
    const readyInventoryId = await autoCreateReadyInventory(targetProduct, null);

    // Build produced items (only the target menu item)
    const targetItem = {
      menuProductId: targetMenuProductId,
      menuProductName: targetProduct.name,
      linkedReadyInventory: readyInventoryId,
      quantity: producedQuantity,
      costPerUnit: 0, // Will be auto-calculated
    };

    // Create BOM for new production
    const newBom = new BOMTransaction({
      date: new Date(),
      referenceNo: `DUP-${sourceMenuProductId.slice(-6)}-${targetMenuProductId.slice(-6)}-${Date.now()}`,
      remarks: `Duplicated recipe from ${sourceProduct.name} to ${targetProduct.name}`,
      rawMaterials,
      producedMenuItems: [targetItem],
      status: "draft",
      createdBy: new mongoose.Types.ObjectId(req.user._id),
    });

    await newBom.save();

    return sendSuccess(
      res,
      {
        bom: newBom,
        sourceProduct: sourceProduct.name,
        targetProduct: targetProduct.name,
        rawMaterialsCount: rawMaterials.length,
      },
      "Recipe duplicated successfully. BOM created in draft status.",
      201
    );
  } catch (error: any) {
    console.error("duplicateRecipe error:", error);
    return sendError(res, error.message || "Failed to duplicate recipe", 500);
  } finally {
    session.endSession();
  }
};
