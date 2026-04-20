import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Discount from "../models/Discount";

const router: Router = Router();

router.get("/", authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const now = new Date();
    const discounts = await Discount.find({
      isActive: true,
      $or: [{ endDate: null }, { endDate: { $gte: now } }],
    })
      .populate("applicableProducts", "name price")
      .populate("applicableCategories", "name")
      .lean();
    return sendSuccess(res, discounts);
  } catch (error) {
    return sendError(res, "Failed to fetch discounts", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const discount = await Discount.create(req.body);
    return sendSuccess(res, discount, "Discount created successfully", 201);
  } catch (error) {
    return sendError(res, "Failed to create discount", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const discount = await Discount.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!discount) return sendError(res, "Discount not found", 404);
    return sendSuccess(res, discount, "Discount updated successfully");
  } catch (error) {
    return sendError(res, "Failed to update discount", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    await Discount.findByIdAndUpdate(req.params.id, { isActive: false });
    return sendSuccess(res, null, "Discount deactivated");
  } catch (error) {
    return sendError(res, "Failed to delete discount", 500);
  }
});

export default router;
