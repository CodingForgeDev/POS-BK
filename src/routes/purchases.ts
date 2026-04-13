import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Purchase from "../models/Purchase";
import { postPurchaseInSession, type PostPurchaseLineInput } from "../lib/purchasePosting";

const router = Router();

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
      if (msg === "SUPPLIER_NOT_FOUND") return sendError(res, "Supplier not found", 400);
      if (msg === "NO_LINES") return sendError(res, "At least one line is required", 400);
      if (msg === "INVALID_QUANTITY") return sendError(res, "Each line must have quantity greater than 0", 400);
      if (msg === "INVALID_COST") return sendError(res, "Invalid unit cost", 400);
      if (msg.startsWith("INVENTORY_NOT_FOUND")) return sendError(res, "One or more inventory items were not found", 400);
      const code = (e as { code?: number })?.code;
      if (code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg)) {
        return sendError(
          res,
          "MongoDB transactions require a replica set. Use MongoDB Atlas or run mongod with --replSet (see server/MONGODB-TRANSACTIONS.md).",
          503
        );
      }
      console.error("Post purchase error:", e);
      return sendError(res, "Failed to record purchase", 500);
    } finally {
      session.endSession();
    }

    const populated = await Purchase.findById((purchasePayload as { _id: unknown })._id)
      .populate("supplier", "name phone")
      .populate("createdBy", "name")
      .populate("lines.inventoryItem", "name unit sku")
      .lean();

    return sendSuccess(res, populated, "Purchase recorded", 201);
  } catch (error) {
    console.error("Post purchase outer error:", error);
    return sendError(res, "Failed to record purchase", 500);
  }
});

export default router;
