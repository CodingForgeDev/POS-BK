import { Router, Response } from "express";
import mongoose from "mongoose";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Inventory from "../models/Inventory";
import StockLayer from "../models/StockLayer";
import { postAdjustmentLayerInSession } from "../lib/purchasePosting";
import { deductInventoryFifo } from "../lib/inventoryFifo";
import { InsufficientStockError } from "../lib/inventoryErrors";

const router: Router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { lowStock, search } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (lowStock === "true") query.$expr = { $lte: ["$currentStock", "$minimumStock"] };
    if (search) query.name = { $regex: search, $options: "i" };

    const items = await Inventory.find(query)
      .populate("lastRestockedBy", "name")
      .sort({ name: 1 })
      .lean();

    return sendSuccess(res, items);
  } catch (error) {
    return sendError(res, "Failed to fetch inventory", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const item = await Inventory.create(req.body);
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

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
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
        } else {
          const qty = -adj;
          await deductInventoryFifo({
            inventoryItemId: id,
            quantity: qty,
            session,
            releaseReserved: 0,
          });
        }
      });
    } catch (e: unknown) {
      if (e instanceof InsufficientStockError) {
        return sendError(res, e.message, 409, { code: e.code, shortages: e.shortages });
      }
      if (e instanceof Error && e.message === "NOT_FOUND") {
        return sendError(res, "Inventory item not found", 404);
      }
      if (e instanceof Error && e.message === "INVENTORY_NOT_FOUND") {
        return sendError(res, "Inventory item not found", 404);
      }
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: number })?.code;
      if (code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg)) {
        return sendError(
          res,
          "MongoDB transactions require a replica set. Use MongoDB Atlas or run mongod with --replSet (see server/MONGODB-TRANSACTIONS.md).",
          503
        );
      }
      console.error("Adjust stock error:", e);
      return sendError(res, "Failed to adjust stock", 500);
    } finally {
      session.endSession();
    }

    const item = await Inventory.findById(id).populate("lastRestockedBy", "name").lean();
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
      .populate("purchase", "referenceNumber receivedAt totalAmount")
      .populate("supplier", "name")
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
    const item = await Inventory.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return sendError(res, "Inventory item not found", 404);
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
