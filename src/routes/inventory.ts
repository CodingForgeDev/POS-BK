import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Inventory from "../models/Inventory";

const router = Router();

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
    const { id, adjustment } = req.body;

    const item = await Inventory.findByIdAndUpdate(
      id,
      {
        $inc: { currentStock: adjustment },
        lastRestockedAt: adjustment > 0 ? new Date() : undefined,
        lastRestockedBy: adjustment > 0 ? req.user.id : undefined,
      },
      { new: true }
    );

    if (!item) return sendError(res, "Inventory item not found", 404);
    return sendSuccess(res, item, `Stock adjusted by ${adjustment}`);
  } catch (error) {
    return sendError(res, "Failed to adjust stock", 500);
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
