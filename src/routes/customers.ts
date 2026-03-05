import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Customer from "../models/Customer";

const router = Router();

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
    const customer = await Customer.create(req.body);
    return sendSuccess(res, customer, "Customer created successfully", 201);
  } catch (error) {
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
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!customer) return sendError(res, "Customer not found", 404);
    return sendSuccess(res, customer, "Customer updated successfully");
  } catch (error) {
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
