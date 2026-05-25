import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import { pickProductPayload } from "../lib/productPayload";
import Product from "../models/Product";
import { 
  calculateRecipeCostPriceForRecipe, 
  calculateProductsCostPrices 
} from "../lib/recipeInventory";
import { calculateProductsAvailability } from "../lib/stockAvailability";

const router: Router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { category, available } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (category) query.category = category;
    if (available === "true") query.isAvailable = true;

    const products = await Product.find(query)
      .populate("category", "name color")
      .populate(
        "recipeLines.inventoryItem",
        "name unit currentStock minimumStock costPerUnit reservedStock"
      )
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    // Calculate stock availability for all products
    const availabilityMap = await calculateProductsAvailability(products);

    // Calculate current cost prices based on recipes and inventory costs
    const costPriceMap = await calculateProductsCostPrices(products);

    // Enrich products with availability data and current cost prices
    const enrichedProducts = products.map((product: any) => {
      const availability = availabilityMap.get(String(product._id));
      const calculatedCostPrice = costPriceMap.get(String(product._id));
      
      return {
        ...product,
        availableQuantity: availability?.availableQuantity ?? -1,
        stockStatus: availability?.stockStatus ?? "available",
        // Use calculated cost price if available, otherwise use stored value
        costPrice: calculatedCostPrice !== undefined ? calculatedCostPrice : product.costPrice,
      };
    });

    return sendSuccess(res, enrichedProducts);
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
    let payload: Record<string, unknown>;
    try {
      payload = pickProductPayload(req.body as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid payload";
      return sendError(res, msg, 400);
    }
    if (Array.isArray(payload.recipeLines) && payload.recipeLines.length > 0) {
      payload.costPrice = await calculateRecipeCostPriceForRecipe(payload.recipeLines as any[]);
    }
    const product = await Product.create(payload);
    await product.populate("category", "name color");
    await product.populate(
      "recipeLines.inventoryItem",
      "name unit currentStock minimumStock costPerUnit"
    );
    return sendSuccess(res, product, "Product created successfully", 201);
  } catch (error) {
    return sendError(res, "Failed to create product", 500);
  }
});

router.get("/stock-status", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { productIds } = req.query as Record<string, string>;

    if (!productIds) {
      return sendError(res, "productIds query parameter is required", 400);
    }

    const ids = productIds.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) {
      return sendSuccess(res, []);
    }

    const products = await Product.find({ _id: { $in: ids }, isActive: true })
      .select("_id isReadyItem recipeLines sku name")
      .populate("recipeLines.inventoryItem", "currentStock reservedStock unit")
      .lean();

    const availabilityMap = await calculateProductsAvailability(products);

    const result = products.map((product: any) => {
      const availability = availabilityMap.get(String(product._id));
      return {
        productId: String(product._id),
        availableQuantity: availability?.availableQuantity ?? Infinity,
        stockStatus: availability?.stockStatus ?? "available",
      };
    });

    return sendSuccess(res, result);
  } catch (error) {
    return sendError(res, "Failed to fetch stock status", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const product = await Product.findById(req.params.id)
      .populate("category", "name color")
      .populate(
        "recipeLines.inventoryItem",
        "name unit currentStock minimumStock costPerUnit"
      )
      .lean();
    if (!product) return sendError(res, "Product not found", 404);
    
    const productData = product as any;
    
    // Calculate current cost price from recipe if available
    if (productData.recipeLines && productData.recipeLines.length > 0) {
      const calculatedCostPrice = await calculateRecipeCostPriceForRecipe(productData.recipeLines);
      return sendSuccess(res, { ...productData, costPrice: calculatedCostPrice });
    }
    
    return sendSuccess(res, productData);
  } catch (error) {
    return sendError(res, "Failed to fetch product", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    let update: Record<string, unknown>;
    try {
      update = pickProductPayload(req.body as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid payload";
      return sendError(res, msg, 400);
    }

    const isToggleOnly =
      req.user.role === "cashier" &&
      Object.keys(update).length === 1 &&
      Object.prototype.hasOwnProperty.call(update, "isAvailable");

    if (!["admin", "manager"].includes(req.user.role) && !isToggleOnly) {
      return sendError(res, "Unauthorized", 403);
    }

    if (Array.isArray(update.recipeLines) && update.recipeLines.length > 0) {
      update.costPrice = await calculateRecipeCostPriceForRecipe(update.recipeLines as any[]);
    }
    if (Object.keys(update).length === 0) {
      return sendError(res, "No valid fields to update", 400);
    }
    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate("category", "name color")
      .populate(
        "recipeLines.inventoryItem",
        "name unit currentStock minimumStock costPerUnit"
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
