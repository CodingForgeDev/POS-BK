import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Customer from "../models/Customer";

const router: Router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { search, page = "1", limit = "20" } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const total = await Customer.countDocuments(query);
    const customers = await Customer.find(query)
      .sort({ totalSpent: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return sendSuccess(res, { customers, total, page: pageNum, limit: limitNum });
  } catch (error) {
    return sendError(res, "Failed to fetch customers", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { name, phone } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return sendError(res, "Customer name is required", 400);
    }
    if (!phone || typeof phone !== "string" || !phone.trim()) {
      return sendError(res, "Customer phone is required", 400);
    }

    req.body.name = name.trim();
    req.body.phone = String(phone).replace(/[^+\d]/g, "");

    const customer = await Customer.create(req.body);
    return sendSuccess(res, customer, "Customer created successfully", 201);
  } catch (error: any) {
    if (error.code === 11000 && error.keyPattern?.phone) {
      return sendError(res, "Phone number already exists", 409);
    }
    return sendError(res, "Failed to create customer", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const customer = await Customer.findById(req.params.id);
    if (!customer) return sendError(res, "Customer not found", 404);
    return sendSuccess(res, customer);
  } catch (error) {
    return sendError(res, "Failed to fetch customer", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { name, phone } = req.body;
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return sendError(res, "Customer name is required", 400);
    }
    if (phone !== undefined && (typeof phone !== "string" || !phone.trim())) {
      return sendError(res, "Customer phone is required", 400);
    }

    if (typeof req.body.name === "string") req.body.name = req.body.name.trim();
    if (typeof req.body.phone === "string") req.body.phone = String(req.body.phone).replace(/[^+\d]/g, "");

    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!customer) return sendError(res, "Customer not found", 404);
    return sendSuccess(res, customer, "Customer updated successfully");
  } catch (error: any) {
    if (error.code === 11000 && error.keyPattern?.phone) {
      return sendError(res, "Phone number already exists", 409);
    }
    return sendError(res, "Failed to update customer", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const customer = await Customer.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!customer) return sendError(res, "Customer not found", 404);
    return sendSuccess(res, null, "Customer removed");
  } catch (error) {
    return sendError(res, "Failed to remove customer", 500);
  }
});

export default router;
