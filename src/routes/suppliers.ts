import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Supplier from "../models/Supplier";

const router: Router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { search } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { contactPerson: { $regex: search, $options: "i" } },
        { supplyCategory: { $regex: search, $options: "i" } },
      ];
    }

    const suppliers = await Supplier.find(query).sort({ name: 1 }).lean();
    return sendSuccess(res, suppliers);
  } catch (error) {
    return sendError(res, "Failed to fetch suppliers", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const supplier = await Supplier.create(req.body);
    return sendSuccess(res, supplier, "Supplier created", 201);
  } catch (error) {
    return sendError(res, "Failed to create supplier", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return sendError(res, "Supplier not found", 404);
    return sendSuccess(res, supplier);
  } catch (error) {
    return sendError(res, "Failed to fetch supplier", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!supplier) return sendError(res, "Supplier not found", 404);
    return sendSuccess(res, supplier, "Supplier updated");
  } catch (error) {
    return sendError(res, "Failed to update supplier", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!supplier) return sendError(res, "Supplier not found", 404);
    return sendSuccess(res, null, "Supplier removed");
  } catch (error) {
    return sendError(res, "Failed to remove supplier", 500);
  }
});

export default router;
