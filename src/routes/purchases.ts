import { Router, Response } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Purchase from "../models/Purchase";
import StockLayer from "../models/StockLayer";
import Inventory from "../models/Inventory";
import Supplier from "../models/Supplier";
import LedgerAccount from "../models/LedgerAccount";
import JournalEntry from "../models/JournalEntry";
import { postPurchaseInSession, type PostPurchaseLineInput } from "../lib/purchasePosting";
import {
  createJournalEntryRecord,
  resolvePurchasePostingAccounts,
} from "../lib/journalPosting";

const router: Router = Router();

async function postPurchaseJournalEntry(purchase: any, session: ClientSession | null = null) {
  const amount = Number(purchase.totalAmount || 0);
  if (!amount || !purchase._id) return;

  const { inventoryAccount, paymentAccount } = await resolvePurchasePostingAccounts(
    String(purchase.supplier?._id || purchase.supplier || ""),
    {
      paymentMethod: String(purchase.paymentMethod || "credit").toLowerCase(),
    }
  );

  if (!inventoryAccount || !paymentAccount) {
    throw new Error(
      `Missing ${!inventoryAccount ? "inventory" : "payment"} account mapping for purchase journal entry. ` +
      "Please review default inventory account and supplier accounts payable settings."
    );
  }

  const supplierName = purchase.supplier?.name || "Unknown Supplier";
  const reference = purchase.referenceNumber || purchase._id?.toString() || "";
  const description = `Purchase from ${supplierName}`;

  const lines = [
    {
      account: inventoryAccount._id,
      accountName: inventoryAccount.title,
      debit: amount,
      credit: 0,
      note: `Purchase from ${supplierName}`,
    },
    {
      account: paymentAccount._id,
      accountName: paymentAccount.title,
      debit: 0,
      credit: amount,
      note: `Purchase from ${supplierName}`,
    },
  ];

  await createJournalEntryRecord({
    date: purchase.receivedAt || new Date(),
    reference,
    description,
    lines,
    source: "PURCHASE",
    sourceId: purchase._id,
    postedBy: purchase.createdBy,
    session,
  });
}

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { supplier, supplierId, paymentStatus, from, to, page = "1", limit = "20" } = req.query as Record<string, string>;

    const query: Record<string, unknown> = { status: "posted" };

    if (supplier || supplierId) {
      query.supplier = supplier || supplierId;
    }

    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }

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
      .select("+paidAmount +paymentStatus")
      .lean();

    const purchasesWithRemaining = purchases.map((p: any) => ({
      ...p,
      remainingAmount: p.totalAmount - (p.paidAmount || 0),
    }));

    return sendSuccess(res, { purchases: purchasesWithRemaining, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("List purchases error:", error);
    return sendError(res, "Failed to fetch purchases", 500);
  }
});

router.get("/next-reference", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const prefix = `PUR-${year}${month}${day}-`;

    const purchases = await Purchase.find({
      referenceNumber: { $regex: `^${prefix}` },
    }).select("referenceNumber").lean();

    let maxSeq = 0;
    for (const p of purchases as any[]) {
      const suffix = String(p.referenceNumber || "").replace(prefix, "");
      const num = parseInt(suffix, 10);
      if (!isNaN(num) && num > maxSeq) maxSeq = num;
    }

    const nextSeq = String(maxSeq + 1).padStart(4, "0");
    return sendSuccess(res, { referenceNumber: `${prefix}${nextSeq}` });
  } catch (error) {
    console.error("Next purchase reference error:", error);
    return sendError(res, "Failed to generate reference number", 500);
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

    const { supplierId, referenceNumber, receivedAt, notes, lines, paymentMethod } = req.body as {
      supplierId?: string | null;
      referenceNumber?: string;
      receivedAt?: string;
      notes?: string;
      lines?: PostPurchaseLineInput[];
      paymentMethod?: string;
    };

    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return sendError(res, "At least one line is required", 400);
    }

    const received = receivedAt ? new Date(receivedAt) : new Date();
    if (Number.isNaN(received.getTime())) {
      return sendError(res, "Invalid receivedAt", 400);
    }

    const normalizedPaymentMethod = String(paymentMethod || "credit").toLowerCase();
    if (!["cash", "credit"].includes(normalizedPaymentMethod)) {
      return sendError(res, "Invalid paymentMethod", 400);
    }

    const session = await mongoose.startSession();
    let purchasePayload: unknown;
    let journalPostedInTransaction = false;
    try {
      await session.withTransaction(async () => {
        const { purchase } = await postPurchaseInSession(session, {
          supplierId: supplierId || null,
          referenceNumber: referenceNumber ?? "",
          receivedAt: received,
          notes: notes ?? "",
          lines,
          paymentMethod: normalizedPaymentMethod,
          userId: req.user.id,
        });
        await postPurchaseJournalEntry(purchase, session);
        journalPostedInTransaction = true;
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

    if (populated && !journalPostedInTransaction) {
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

    const { supplierId, referenceNumber, receivedAt, notes, lines, paymentMethod } = req.body as {
      supplierId?: string | null;
      referenceNumber?: string;
      receivedAt?: string;
      notes?: string;
      lines?: PostPurchaseLineInput[];
      paymentMethod?: string;
    };

    const purchaseDoc = (await Purchase.findById(req.params.id).lean()) as any;
    if (!purchaseDoc) return sendError(res, "Purchase not found", 404);
    if (purchaseDoc.status !== "posted") return sendError(res, "Only posted purchases can be edited", 400);

    const updateBody: Record<string, unknown> = {};
    let supplierOid: mongoose.Types.ObjectId | null = null;
    let receivedAtDate: Date | null = null;

    // ── Resolve supplier ──────────────────────────────────────────────────────
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

    // ── Normalize paymentMethod — MUST be resolved before journal block ───────
    // Use the incoming value if provided, otherwise fall back to what's stored.
    const resolvedPaymentMethod = paymentMethod !== undefined
      ? String(paymentMethod).toLowerCase()
      : String(purchaseDoc.paymentMethod || "credit").toLowerCase();

    if (!["cash", "credit"].includes(resolvedPaymentMethod)) {
      return sendError(res, "Invalid paymentMethod", 400);
    }
    if (paymentMethod !== undefined) {
      updateBody.paymentMethod = resolvedPaymentMethod;
    }

    // ── Validate & normalise lines ────────────────────────────────────────────
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
      updateBody.totalAmount = normalizedLines.reduce(
        (sum, line) => sum + line.quantity * line.unitCost,
        0
      );
      lineUpdates = true;
    }

    // ── Resolve current supplier ID as plain string for account lookup ────────
    // supplierOid is set only when the supplier is being *changed* in this request.
    // Fall back to the stored supplier on the purchase doc.
    const currentSupplierIdStr = supplierOid
      ? supplierOid.toString()
      : String(purchaseDoc.supplier || "");

    // ── Execute DB writes ─────────────────────────────────────────────────────
    const session = await mongoose.startSession();
    let updatedPurchaseId: unknown;

    const performUpdates = async (sess: ClientSession | null) => {
      const opts = sess ? { session: sess } : {};

      // 1. Update the purchase document
      if (Object.keys(updateBody).length > 0) {
        await Purchase.updateOne({ _id: purchaseDoc._id }, { $set: updateBody }, opts);
      }

      // 2. Update stock layers & inventory quantities
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
              opts
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
            opts
          );
        }
      }

      // 3. Sync supplier / date on existing stock layers
      const layerUpdate: Record<string, unknown> = {};
      if (supplierId !== undefined) layerUpdate.supplier = supplierOid;
      if (receivedAtDate !== null) layerUpdate.receivedAt = receivedAtDate;
      if (Object.keys(layerUpdate).length > 0) {
        await StockLayer.updateMany({ purchase: purchaseDoc._id }, { $set: layerUpdate }, opts);
      }

      // 4. Update the linked journal entry so ledger balances stay in sync ─────
      const existingJournalEntry = await JournalEntry.findOne({
        source: "PURCHASE",
        sourceId: purchaseDoc._id,
      }).session(sess ?? undefined);

      if (existingJournalEntry) {
        // Resolve posting accounts using the definitive supplier string & payment method
        const { inventoryAccount, paymentAccount } = await resolvePurchasePostingAccounts(
          currentSupplierIdStr,
          { paymentMethod: resolvedPaymentMethod }
        );

        if (!inventoryAccount || !paymentAccount) {
          throw new Error(
            `Missing ${!inventoryAccount ? "inventory" : "payment"} account mapping for purchase journal entry update.`
          );
        }

        // Fetch supplier name for description
        const currentSupplierDoc = currentSupplierIdStr
          ? await Supplier.findById(currentSupplierIdStr).lean()
          : null;
        const supplierName = (currentSupplierDoc as any)?.name || "Unknown Supplier";

        // New total: use updated value if lines were changed, else keep existing
        const journalAmount = Number(updateBody.totalAmount ?? purchaseDoc.totalAmount ?? 0);

        const updatedJournalLines = [
          {
            account: inventoryAccount._id,
            accountName: inventoryAccount.title,
            debit: journalAmount,
            credit: 0,
            note: `Purchase from ${supplierName}`,
          },
          {
            account: paymentAccount._id,
            accountName: paymentAccount.title,
            debit: 0,
            credit: journalAmount,
            note: `Purchase from ${supplierName}`,
          },
        ];

        // ── Recompute running balances on affected ledger accounts ────────────
        // Build maps: accountId → old amounts, accountId → new amounts
        const oldLineMap = new Map<string, { debit: number; credit: number }>();
        for (const line of existingJournalEntry.lines || []) {
          oldLineMap.set(String(line.account), {
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
          });
        }

        const newLineMap = new Map<string, { debit: number; credit: number }>();
        for (const line of updatedJournalLines) {
          newLineMap.set(String(line.account), {
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
          });
        }

        const accountIds = new Set<string>([
          ...Array.from(oldLineMap.keys()),
          ...Array.from(newLineMap.keys()),
        ]);

        for (const accountId of accountIds) {
          const oldValues = oldLineMap.get(accountId) || { debit: 0, credit: 0 };
          const newValues = newLineMap.get(accountId) || { debit: 0, credit: 0 };

          const ledgerAccount = await LedgerAccount.findById(accountId)
            .session(sess ?? undefined)
            .lean();
          if (!ledgerAccount) continue;

          const isNormalDebitAccount = ["asset", "bank", "receivable", "expense"].includes(
            String((ledgerAccount as any).type || "").toLowerCase()
          );

          // Delta = change in balance impact for this account
          const oldDelta = isNormalDebitAccount
            ? oldValues.debit - oldValues.credit
            : oldValues.credit - oldValues.debit;
          const newDelta = isNormalDebitAccount
            ? newValues.debit - newValues.credit
            : newValues.credit - newValues.debit;
          const delta = newDelta - oldDelta;

          if (delta !== 0) {
            await LedgerAccount.updateOne(
              { _id: accountId },
              { $inc: { currentBalance: delta } },
              opts
            );
          }
        }

        // ── Overwrite the journal entry document ──────────────────────────────
        await JournalEntry.updateOne(
          { _id: existingJournalEntry._id },
          {
            $set: {
              date: receivedAtDate ?? purchaseDoc.receivedAt ?? new Date(),
              reference: String(updateBody.referenceNumber ?? purchaseDoc.referenceNumber ?? ""),
              description: `Purchase from ${supplierName}`,
              lines: updatedJournalLines,
              totalDebit: journalAmount,
              totalCredit: journalAmount,
              postedBy: existingJournalEntry.postedBy || req.user.id,
              status: "posted",
            },
          },
          opts
        );
      }

      updatedPurchaseId = purchaseDoc._id;
    };

    // ── Try with transaction, fall back to direct writes ──────────────────────
    try {
      await session.withTransaction(async () => {
        await performUpdates(session);
      });
    } catch (e: unknown) {
      const err = e as { message?: string; code?: number };
      const msg = err?.message ?? String(e);
      const code = err?.code;
      const isTransactionUnavailable =
        code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg);

      if (isTransactionUnavailable) {
        console.warn("Transactions unavailable, falling back to non-transactional purchase update.");
        try {
          await performUpdates(null);
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

    const populated = await Purchase.findById(String(updatedPurchaseId))
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