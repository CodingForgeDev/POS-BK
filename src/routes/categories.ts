import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Category from "../models/Category";

const router = Router();

router.get("/", authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
    return sendSuccess(res, categories);
  } catch (error) {
    return sendError(res, "Failed to fetch categories", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const category = await Category.create(req.body);
    return sendSuccess(res, category, "Category created successfully", 201);
  } catch (error) {
    return sendError(res, "Failed to create category", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!category) return sendError(res, "Category not found", 404);
    return sendSuccess(res, category, "Category updated");
  } catch (error) {
    return sendError(res, "Failed to update category", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    await Category.findByIdAndUpdate(req.params.id, { isActive: false });
    return sendSuccess(res, null, "Category removed");
  } catch (error) {
    return sendError(res, "Failed to remove category", 500);
  }
});

export default router;
