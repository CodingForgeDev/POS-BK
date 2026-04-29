import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Purchase from "../models/Purchase";
import StockLayer from "../models/StockLayer";
import Inventory from "../models/Inventory";
import Supplier from "../models/Supplier";
import { postPurchaseInSession, type PostPurchaseLineInput } from "../lib/purchasePosting";
import { createJournalEntryRecord, findLedgerAccount } from "../lib/journalPosting";

const router: Router = Router();

async function postPurchaseJournalEntry(purchase: any) {
  const amount = Number(purchase.totalAmount || 0);
  if (!amount || !purchase._id) return;

  const inventoryAccount =
    (await findLedgerAccount({ title: /inventory/i })) ||
    (await findLedgerAccount({ type: "asset" }));
  const payableAccount =
    (await findLedgerAccount({ type: "liability" })) ||
    (await findLedgerAccount({ type: { $in: ["bank", "asset"] } }));

  if (!inventoryAccount || !payableAccount) {
    console.warn("Skipped purchase journal entry: missing inventory or payable account mapping");
    return;
  }

  const lines = [
    {
      account: inventoryAccount._id,
      accountName: inventoryAccount.title,
      debit: amount,
      credit: 0,
      note: `Purchase ${purchase.referenceNumber || purchase._id}`,
    },
    {
      account: payableAccount._id,
      accountName: payableAccount.title,
      debit: 0,
      credit: amount,
      note: `Purchase ${purchase.referenceNumber || purchase._id}`,
    },
  ];

  try {
    await createJournalEntryRecord({
      date: purchase.receivedAt || new Date(),
      reference: purchase.referenceNumber || purchase._id?.toString() || "",
      description: `Purchase ${purchase.referenceNumber || purchase._id}`,
      lines,
      source: "PURCHASE",
      sourceId: purchase._id,
      postedBy: purchase.createdBy,
    });
  } catch (err: any) {
    if (err?.message === "Journal entry already exists for this source") return;
    console.error("Failed to create purchase journal entry:", err);
  }
}

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { supplier, from, to, page = "1", limit = "20" } = req.query as Record<string, string>;

    const query: Record<string, unknown> = { status: "posted" };
    if (supplier) query.supplier = supplier;
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
      query.receivedAt = range;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const total = await Purchase.countDocuments(query);
    const purchases = await Purchase.find(query)
      .sort({ receivedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("supplier", "name phone")
      .populate("createdBy", "name")
      .populate("lines.inventoryItem", "name unit sku")
      .lean();

    return sendSuccess(res, { purchases, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("List purchases error:", error);
    return sendError(res, "Failed to fetch purchases", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const doc = await Purchase.findById(req.params.id)
      .populate("supplier", "name phone email address")
      .populate("createdBy", "name")
      .populate("lines.inventoryItem", "name unit sku category")
      .lean();
    if (!doc) return sendError(res, "Purchase not found", 404);
    return sendSuccess(res, doc);
  } catch (error) {
    console.error("Get purchase error:", error);
    return sendError(res, "Failed to fetch purchase", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }

    const { supplierId, referenceNumber, receivedAt, notes, lines } = req.body as {
      supplierId?: string | null;
      referenceNumber?: string;
      receivedAt?: string;
      notes?: string;
      lines?: PostPurchaseLineInput[];
    };

    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return sendError(res, "At least one line is required", 400);
    }

    const received = receivedAt ? new Date(receivedAt) : new Date();
    if (Number.isNaN(received.getTime())) {
      return sendError(res, "Invalid receivedAt", 400);
    }

    const session = await mongoose.startSession();
    let purchasePayload: unknown;
    try {
      await session.withTransaction(async () => {
        const { purchase } = await postPurchaseInSession(session, {
          supplierId: supplierId || null,
          referenceNumber: referenceNumber ?? "",
          receivedAt: received,
          notes: notes ?? "",
          lines,
          userId: req.user.id,
        });
        purchasePayload = purchase;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: number })?.code;
      const isTransactionUnavailable =
        code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg);
      if (isTransactionUnavailable) {
        console.warn("Transactions unavailable, falling back to non-transactional purchase posting.");
        try {
          const { purchase } = await postPurchaseInSession(null, {
            supplierId: supplierId || null,
            referenceNumber: referenceNumber ?? "",
            receivedAt: received,
            notes: notes ?? "",
            lines,
            userId: req.user.id,
          });
          purchasePayload = purchase;
        } catch (innerError: unknown) {
          const innerMsg = innerError instanceof Error ? innerError.message : String(innerError);
          if (innerMsg === "SUPPLIER_NOT_FOUND") return sendError(res, "Supplier not found", 400);
          if (innerMsg === "NO_LINES") return sendError(res, "At least one line is required", 400);
          if (innerMsg === "INVALID_QUANTITY") return sendError(res, "Each line must have quantity greater than 0", 400);
          if (innerMsg === "INVALID_COST") return sendError(res, "Invalid unit cost", 400);
          if (innerMsg.startsWith("INVENTORY_NOT_FOUND")) return sendError(res, "One or more inventory items were not found", 400);
          console.error("Post purchase fallback error:", innerError);
          return sendError(res, "Failed to record purchase", 500);
        }
      } else {
        if (msg === "SUPPLIER_NOT_FOUND") return sendError(res, "Supplier not found", 400);
        if (msg === "NO_LINES") return sendError(res, "At least one line is required", 400);
        if (msg === "INVALID_QUANTITY") return sendError(res, "Each line must have quantity greater than 0", 400);
        if (msg === "INVALID_COST") return sendError(res, "Invalid unit cost", 400);
        if (msg.startsWith("INVENTORY_NOT_FOUND")) return sendError(res, "One or more inventory items were not found", 400);
        console.error("Post purchase error:", e);
        return sendError(res, "Failed to record purchase", 500);
      }
    } finally {
      session.endSession();
    }

    const populated = await Purchase.findById((purchasePayload as { _id: unknown })._id)
      .populate("supplier", "name phone")
      .populate("createdBy", "name")
      .populate("lines.inventoryItem", "name unit sku")
      .lean();

    if (populated) {
      await postPurchaseJournalEntry(populated);
    }

    return sendSuccess(res, populated, "Purchase recorded", 201);
  } catch (error) {
    console.error("Post purchase outer error:", error);
    return sendError(res, "Failed to record purchase", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }

    const { supplierId, referenceNumber, receivedAt, notes, lines } = req.body as {
      supplierId?: string | null;
      referenceNumber?: string;
      receivedAt?: string;
      notes?: string;
      lines?: PostPurchaseLineInput[];
    };

    const purchaseDoc = (await Purchase.findById(req.params.id).lean()) as any;
    if (!purchaseDoc) return sendError(res, "Purchase not found", 404);
    if (purchaseDoc.status !== "posted") return sendError(res, "Only posted purchases can be edited", 400);

    const updateBody: Record<string, unknown> = {};
    let supplierOid: mongoose.Types.ObjectId | null = null;
    let receivedAtDate: Date | null = null;

    if (supplierId !== undefined) {
      if (supplierId) {
        if (!mongoose.Types.ObjectId.isValid(supplierId)) {
          return sendError(res, "Supplier not found", 400);
        }
        const supplierDoc = await Supplier.findById(supplierId).lean();
        if (!supplierDoc) {
          return sendError(res, "Supplier not found", 400);
        }
        supplierOid = new mongoose.Types.ObjectId(supplierId);
      }
      updateBody.supplier = supplierOid;
    }

    if (referenceNumber !== undefined) {
      updateBody.referenceNumber = String(referenceNumber).trim();
    }

    if (receivedAt !== undefined) {
      const parsed = new Date(receivedAt);
      if (Number.isNaN(parsed.getTime())) {
        return sendError(res, "Invalid receivedAt", 400);
      }
      receivedAtDate = parsed;
      updateBody.receivedAt = parsed;
    }

    if (notes !== undefined) {
      updateBody.notes = String(notes);
    }

    let normalizedLines: PostPurchaseLineInput[] | null = null;
    let lineUpdateMap = new Map<number, any>();
    let lineUpdates = false;

    if (lines !== undefined) {
      if (!Array.isArray(lines) || lines.length === 0) {
        return sendError(res, "At least one line is required", 400);
      }

      normalizedLines = lines.map((l) => ({
        inventoryItem: String(l.inventoryItem),
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
        packSize: l.packSize ?? null,
        notes: l.notes ?? "",
      }));

      if (normalizedLines.some((l) => !mongoose.Types.ObjectId.isValid(l.inventoryItem))) {
        return sendError(res, "Invalid inventory item provided", 400);
      }

      for (const line of normalizedLines) {
        if (!(line.quantity > 0)) {
          return sendError(res, "Each line must have quantity greater than 0", 400);
        }
        if (line.unitCost < 0) {
          return sendError(res, "Invalid unit cost", 400);
        }
      }

      if (!purchaseDoc.lines || normalizedLines.length !== purchaseDoc.lines.length) {
        return sendError(res, "Changing purchase line count is not supported yet", 400);
      }

      const stockLayers = await StockLayer.find({ purchase: purchaseDoc._id }).lean();
      lineUpdateMap = new Map(stockLayers.map((layer) => [layer.lineIndex, layer]));

      for (let idx = 0; idx < normalizedLines.length; idx += 1) {
        const newLine = normalizedLines[idx];
        const oldLine = purchaseDoc.lines[idx] as any;
        if (String(oldLine.inventoryItem) !== String(newLine.inventoryItem)) {
          return sendError(res, "Changing inventory item for an existing purchase line is not supported", 400);
        }
        const layer = lineUpdateMap.get(idx);
        if (!layer) {
          return sendError(res, "Purchase stock layer not found", 400);
        }
        if (Number(layer.quantityRemaining) !== Number(layer.quantityOriginal)) {
          return sendError(res, "Cannot edit a purchase after some stock has been consumed", 400);
        }
      }

      updateBody.lines = normalizedLines.map((line) => ({
        ...line,
        inventoryItem: new mongoose.Types.ObjectId(line.inventoryItem),
      }));
      updateBody.totalAmount = normalizedLines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
      lineUpdates = true;
    }

    const session = await mongoose.startSession();
    let updatedPurchasePayload: unknown;

    try {
      await session.withTransaction(async () => {
        const updateOptions = { session };

        if (Object.keys(updateBody).length > 0) {
          await Purchase.updateOne({ _id: purchaseDoc._id }, { $set: updateBody }, updateOptions);
        }

        if (lineUpdates && normalizedLines) {
          for (let idx = 0; idx < normalizedLines.length; idx += 1) {
            const newLine = normalizedLines[idx];
            const oldLine = purchaseDoc.lines[idx] as any;
            const layer = lineUpdateMap.get(idx);
            const diff = newLine.quantity - Number(oldLine.quantity);

            if (diff !== 0) {
              await Inventory.updateOne(
                { _id: new mongoose.Types.ObjectId(newLine.inventoryItem) },
                { $inc: { currentStock: diff } },
                updateOptions
              );
            }

            await StockLayer.updateOne(
              { _id: layer._id },
              {
                $set: {
                  quantityOriginal: newLine.quantity,
                  quantityRemaining: newLine.quantity,
                  unitCost: newLine.unitCost,
                },
              },
              updateOptions
            );
          }
        }

        const layerUpdate: Record<string, unknown> = {};
        if (supplierId !== undefined) layerUpdate.supplier = supplierOid;
        if (receivedAtDate !== null) layerUpdate.receivedAt = receivedAtDate;

        if (Object.keys(layerUpdate).length > 0) {
          await StockLayer.updateMany({ purchase: purchaseDoc._id }, { $set: layerUpdate }, { session });
        }

        updatedPurchasePayload = purchaseDoc._id;
      });
    } catch (e: unknown) {
      const err = e as { message?: string; code?: number };
      const msg = err?.message ?? String(e);
      const code = err?.code;
      const isTransactionUnavailable = code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg);
      if (isTransactionUnavailable) {
        console.warn("Transactions unavailable, falling back to non-transactional purchase update.");
        try {
          if (Object.keys(updateBody).length > 0) {
            await Purchase.updateOne({ _id: purchaseDoc._id }, { $set: updateBody });
          }
          if (lineUpdates && normalizedLines) {
            for (let idx = 0; idx < normalizedLines.length; idx += 1) {
              const newLine = normalizedLines[idx];
              const oldLine = purchaseDoc.lines[idx] as any;
              const layer = lineUpdateMap.get(idx);
              const diff = newLine.quantity - Number(oldLine.quantity);

              if (diff !== 0) {
                await Inventory.updateOne(
                  { _id: new mongoose.Types.ObjectId(newLine.inventoryItem) },
                  { $inc: { currentStock: diff } }
                );
              }

              await StockLayer.updateOne(
                { _id: layer._id },
                {
                  $set: {
                    quantityOriginal: newLine.quantity,
                    quantityRemaining: newLine.quantity,
                    unitCost: newLine.unitCost,
                  },
                }
              );
            }
          }
          const layerUpdate: Record<string, unknown> = {};
          if (supplierId !== undefined) layerUpdate.supplier = supplierOid;
          if (receivedAtDate !== null) layerUpdate.receivedAt = receivedAtDate;
          if (Object.keys(layerUpdate).length > 0) {
            await StockLayer.updateMany({ purchase: purchaseDoc._id }, { $set: layerUpdate });
          }
          updatedPurchasePayload = purchaseDoc._id;
        } catch (innerError: unknown) {
          console.error("Purchase update fallback error:", innerError);
          return sendError(res, "Failed to update purchase", 500);
        }
      } else {
        console.error("Purchase update error:", e);
        return sendError(res, "Failed to update purchase", 500);
      }
    } finally {
      session.endSession();
    }

    const populated = await Purchase.findById(String(updatedPurchasePayload))
      .populate("supplier", "name phone")
      .populate("createdBy", "name")
      .populate("lines.inventoryItem", "name unit sku")
      .lean();

    return sendSuccess(res, populated, "Purchase updated", 200);
  } catch (error) {
    console.error("Update purchase outer error:", error);
    return sendError(res, "Failed to update purchase", 500);
  }
});

export default router;
