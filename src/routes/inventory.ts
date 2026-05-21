import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Inventory from "../models/Inventory";
import StockLayer from "../models/StockLayer";
import { postAdjustmentLayerInSession } from "../lib/purchasePosting";
import { deductInventoryFifo } from "../lib/inventoryFifo";
import { recalculateProductCostPriceForInventoryItem } from "../lib/recipeInventory";
import { InsufficientStockError } from "../lib/inventoryErrors";
import { createJournalEntryRecord, resolvePurchasePostingAccounts } from "../lib/journalPosting";
import Supplier from "../models/Supplier";

async function generateUniqueInventorySku(): Promise<string> {
  const now = new Date();
  const dateCode = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const randomSegment = String(Math.floor(Math.random() * 9000) + 1000);
    const sku = `SKU-${dateCode}-${randomSegment}`;
    const exists = await Inventory.exists({ sku });
    if (!exists) return sku;
  }

  return `SKU-${dateCode}-${Date.now()}`;
}

const router: Router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { lowStock, search, unit, createdBy, from, to, inventoryType } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (lowStock === "true") query.$expr = { $lte: ["$currentStock", "$minimumStock"] };
    if (lowStock === "false") query.$expr = { $gt: ["$currentStock", "$minimumStock"] };
    if (unit) query.unit = unit;
    if (inventoryType) query.inventoryType = inventoryType;
    if (createdBy) {
      query.$or = [{ createdBy }, { lastRestockedBy: createdBy }];
    }
    if (from || to) {
      const range: any = {};
      if (from) range.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
      query.createdAt = range;
    }
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { supplierName: { $regex: search, $options: "i" } },
      ];
    }

    const items = await Inventory.find(query)
      .populate("lastRestockedBy", "name")
      .populate("createdBy", "name")
      .populate("supplier", "name")
      .sort({ name: 1 })
      .lean();

    return sendSuccess(res, items);
  } catch (error) {
    return sendError(res, "Failed to fetch inventory", 500);
  }
});

router.get("/adjustments", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { inventoryItemId } = req.query as Record<string, string>;
    const query: any = { sourceType: { $in: ["adjustment", "production", "pos"] } };
    if (inventoryItemId) query.inventoryItem = inventoryItemId;

    const layers = await StockLayer.find(query)
      .sort({ receivedAt: -1, _id: -1 })
      .populate("inventoryItem", "name sku unit")
      .populate("supplier", "name")
      .populate("createdBy", "name")
      .lean();

    const rows = layers.map((layer) => ({
      _id: String(layer._id),
      inventoryItemId: String(layer.inventoryItem?._id ?? layer.inventoryItem),
      inventoryItemName: String(layer.inventoryItem?.name ?? "Unknown item"),
      supplierId: layer.supplier?._id ? String(layer.supplier._id) : undefined,
      supplierName: layer.supplier?.name || undefined,
      sourceType: layer.sourceType,
      actionLabel: layer.actionLabel || undefined,
      adjustmentType: layer.adjustmentType as "add" | "remove",
      status: "approved" as const,
      quantity: layer.quantityOriginal,
      quantityWeight: undefined,
      unit: layer.inventoryItem?.unit || "unit",
      unitCost: layer.unitCost,
      reason: undefined,
      createdBy: layer.createdBy ? { _id: String(layer.createdBy._id), name: layer.createdBy.name } : undefined,
      approvedBy: undefined,
      rejectedBy: undefined,
      approvedAt: null,
      rejectedAt: null,
      createdAt: layer.createdAt ? layer.createdAt.toISOString() : new Date().toISOString(),
    }));

    return sendSuccess(res, rows);
  } catch (error) {
    console.error("Fetch inventory adjustments error:", error);
    return sendError(res, "Failed to fetch inventory adjustments", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }

    const {
      name,
      sku,
      category,
      unit,
      currentStock = 0,
      minimumStock = 0,
      maximumStock = 100,
      costPerUnit = 0,
      defaultPackSize = null,
      supplier,
      supplierName,
      supplierContact,
      notes,
    } = req.body as Record<string, unknown>;

    const normalizedSku = typeof sku === "string" && sku.trim() !== "" ? sku.trim() : await generateUniqueInventorySku();
    const normalizedSupplierName = typeof supplierName === "string" ? supplierName.trim() : "";

    const item = await Inventory.create({
      name,
      sku: normalizedSku,
      category,
      unit,
      currentStock,
      minimumStock,
      maximumStock,
      costPerUnit,
      defaultPackSize,
      supplier,
      supplierName: normalizedSupplierName,
      supplierContact,
      notes,
      createdBy: req.user.id,
      lastRestockedBy: Number(currentStock) > 0 ? req.user.id : null,
      lastRestockedAt: Number(currentStock) > 0 ? new Date() : null,
    });

    if (Number(currentStock) > 0) {
      const openingDate = new Date();
      const openingLayer = await StockLayer.create({
        sourceType: "opening",
        purchase: null,
        lineIndex: 0,
        inventoryItem: item._id,
        supplier: supplier || null,
        createdBy: req.user.id,
        receivedAt: openingDate,
        quantityOriginal: Number(currentStock),
        quantityRemaining: Number(currentStock),
        unitCost: Number(costPerUnit) || 0,
      });

      // Create journal entry for opening balance if supplier is specified
      // This posts the initial A/P liability
      if (supplier) {
        try {
          const amount = Number(currentStock) * Number(costPerUnit);
          if (amount > 0) {
            const { inventoryAccount, paymentAccount } = await resolvePurchasePostingAccounts(
              String(supplier),
              { paymentMethod: "credit" }
            );

            if (inventoryAccount && paymentAccount) {
              // Get supplier name for description
              const supplierDoc = await Supplier.findById(supplier).lean() as any;
              const supplierNameForEntry = supplierDoc?.name || "Unknown Supplier";

              const lines = [
                {
                  account: inventoryAccount._id,
                  accountName: inventoryAccount.title,
                  debit: amount,
                  credit: 0,
                  note: `Opening balance from ${supplierNameForEntry}`,
                },
                {
                  account: paymentAccount._id,
                  accountName: paymentAccount.title,
                  debit: 0,
                  credit: amount,
                  note: `Opening balance from ${supplierNameForEntry}`,
                },
              ];

              await createJournalEntryRecord({
                date: openingDate,
                reference: `OB-${openingLayer._id.toString().substring(0, 8)}`,
                description: `Opening balance: ${item.name} from ${supplierNameForEntry}`,
                lines,
                source: "MANUAL",
                sourceId: null,
                postedBy: req.user.id,
              });
            }
          }
        } catch (err: any) {
          // Log but don't fail - opening balance is recorded even if journal entry fails
          console.warn("Failed to create opening balance journal entry:", err.message);
        }
      }
    }

    return sendSuccess(res, item, "Inventory item created", 201);
  } catch (error) {
    return sendError(res, "Failed to create inventory item", 500);
  }
});

router.patch("/adjust", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }

    const { id, adjustment, unitCost } = req.body as { id?: string; adjustment?: number; unitCost?: number };
    const adj = Number(adjustment);
    if (!id || Number.isNaN(adj) || adj === 0) {
      return sendError(res, "Valid id and non-zero adjustment are required", 400);
    }
    if (adj < 0 && req.user.role !== "admin") {
      return sendError(res, "Unauthorized", 403);
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const stockLayerOptions = session ? { session } : undefined;

        if (adj > 0) {
          const inv = await Inventory.findOne({ _id: id, isActive: true }).session(session);
          if (!inv) throw new Error("NOT_FOUND");
          const cost =
            unitCost != null && !Number.isNaN(Number(unitCost)) ? Number(unitCost) : Number(inv.costPerUnit) || 0;
          await postAdjustmentLayerInSession(session, {
            inventoryItemId: id,
            quantity: adj,
            unitCost: cost,
            userId: req.user.id,
          });
          await Inventory.findByIdAndUpdate(
            id,
            { lastRestockedBy: req.user.id, lastRestockedAt: new Date() },
            { session }
          );
        } else {
          const qty = -adj;
          const inv = await Inventory.findOne({ _id: id, isActive: true }).session(session);
          if (!inv) throw new Error("NOT_FOUND");
          await deductInventoryFifo({
            inventoryItemId: id,
            quantity: qty,
            session,
            releaseReserved: 0,
          });

          await StockLayer.create(
            [
              {
                sourceType: "adjustment",
                purchase: null,
                lineIndex: 0,
                inventoryItem: id,
                supplier: null,
                createdBy: req.user.id,
                adjustmentType: "remove",
                receivedAt: new Date(),
                quantityOriginal: qty,
                quantityRemaining: 0,
                unitCost: Number(inv.costPerUnit) || 0,
              },
            ],
            stockLayerOptions
          );
        }
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: number })?.code;
      const isTransactionUnavailable =
        code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg);
      if (isTransactionUnavailable && adj > 0) {
        console.warn("Transactions unavailable, falling back to non-transactional adjustment posting.");
        try {
          const inv = await Inventory.findOne({ _id: id, isActive: true });
          if (!inv) throw new Error("NOT_FOUND");
          const cost =
            unitCost != null && !Number.isNaN(Number(unitCost)) ? Number(unitCost) : Number(inv.costPerUnit) || 0;
          await postAdjustmentLayerInSession(null, {
            inventoryItemId: id,
            quantity: adj,
            unitCost: cost,
            userId: req.user.id,
          });
          await Inventory.findByIdAndUpdate(id, {
            lastRestockedBy: req.user.id,
            lastRestockedAt: new Date(),
          });
        } catch (innerError: unknown) {
          if (innerError instanceof InsufficientStockError) {
            return sendError(res, innerError.message, 409, { code: innerError.code, shortages: innerError.shortages });
          }
          if (innerError instanceof Error && innerError.message === "NOT_FOUND") {
            return sendError(res, "Inventory item not found", 404);
          }
          if (innerError instanceof Error && innerError.message === "INVENTORY_NOT_FOUND") {
            return sendError(res, "Inventory item not found", 404);
          }
          console.error("Adjust stock fallback error:", innerError);
          return sendError(res, "Failed to adjust stock", 500);
        }
      } else {
        if (e instanceof InsufficientStockError) {
          return sendError(res, e.message, 409, { code: e.code, shortages: e.shortages });
        }
        if (e instanceof Error && e.message === "NOT_FOUND") {
          return sendError(res, "Inventory item not found", 404);
        }
        if (e instanceof Error && e.message === "INVENTORY_NOT_FOUND") {
          return sendError(res, "Inventory item not found", 404);
        }
        console.error("Adjust stock error:", e);
        return sendError(res, "Failed to adjust stock", 500);
      }
    } finally {
      session.endSession();
    }

    const item = await Inventory.findById(id)
      .populate("lastRestockedBy", "name")
      .populate("createdBy", "name")
      .lean();
    if (!item) return sendError(res, "Inventory item not found", 404);
    return sendSuccess(res, item, `Stock adjusted by ${adj}`);
  } catch (error) {
    console.error("Adjust stock outer error:", error);
    return sendError(res, "Failed to adjust stock", 500);
  }
});

router.get("/:id/layers", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const inv = await Inventory.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!inv) return sendError(res, "Inventory item not found", 404);

    const layers = await StockLayer.find({ inventoryItem: req.params.id })
      .sort({ receivedAt: 1, _id: 1 })
      .populate({
        path: "purchase",
        select: "referenceNumber receivedAt totalAmount createdBy",
        populate: { path: "createdBy", select: "name" },
      })
      .populate("supplier", "name")
      .populate("createdBy", "name")
      .lean();

    return sendSuccess(res, layers);
  } catch (error) {
    console.error("List stock layers error:", error);
    return sendError(res, "Failed to fetch stock layers", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }

    const updateBody = { ...req.body } as Record<string, unknown>;
    if (typeof updateBody.sku === "string" && updateBody.sku.trim() === "") {
      delete updateBody.sku;
    }
    if (typeof updateBody.supplierName === "string") {
      updateBody.supplierName = updateBody.supplierName.trim();
    }

    const item = await Inventory.findByIdAndUpdate(req.params.id, updateBody, { new: true });
    if (!item) return sendError(res, "Inventory item not found", 404);
    if (updateBody.costPerUnit !== undefined) {
      await recalculateProductCostPriceForInventoryItem(req.params.id);
    }
    return sendSuccess(res, item, "Inventory item updated");
  } catch (error) {
    return sendError(res, "Failed to update inventory item", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    await Inventory.findByIdAndUpdate(req.params.id, { isActive: false });
    return sendSuccess(res, null, "Inventory item removed");
  } catch (error) {
    return sendError(res, "Failed to remove inventory item", 500);
  }
});

export default router;
