import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Product from "../models/Product";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { category, available } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (category) query.category = category;
    if (available === "true") query.isAvailable = true;

    const products = await Product.find(query)
      .populate("category", "name color")
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    return sendSuccess(res, products);
  } catch (error) {
    return sendError(res, "Failed to fetch products", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const product = await Product.create(req.body);
    const populated = await product.populate("category", "name color");
    return sendSuccess(res, populated, "Product created successfully", 201);
  } catch (error) {
    return sendError(res, "Failed to create product", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const product = await Product.findById(req.params.id).populate("category", "name color");
    if (!product) return sendError(res, "Product not found", 404);
    return sendSuccess(res, product);
  } catch (error) {
    return sendError(res, "Failed to fetch product", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate(
      "category",
      "name color"
    );
    if (!product) return sendError(res, "Product not found", 404);
    return sendSuccess(res, product, "Product updated successfully");
  } catch (error) {
    return sendError(res, "Failed to update product", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!product) return sendError(res, "Product not found", 404);
    return sendSuccess(res, null, "Product deleted successfully");
  } catch (error) {
    return sendError(res, "Failed to delete product", 500);
  }
});

export default router;
