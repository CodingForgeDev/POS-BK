import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Purchase from "../models/Purchase";
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

export default router;
