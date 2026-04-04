import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import ExpenseBank from "../models/ExpenseBank";

const router = Router();

router.get("/", authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const banks = await ExpenseBank.find().sort({ name: 1 }).lean();
    return sendSuccess(res, banks);
  } catch (error) {
    console.error("List expense banks error:", error);
    return sendError(res, "Failed to fetch banks", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return sendError(res, "Bank name is required", 400);
    const bank = await ExpenseBank.create({ name });
    return sendSuccess(res, bank, "Bank added", 201);
  } catch (error: any) {
    if (error?.code === 11000) {
      return sendError(res, "A bank with this name already exists", 409);
    }
    console.error("Create expense bank error:", error);
    return sendError(res, "Failed to add bank", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return sendError(res, "Bank name is required", 400);
    const bank = await ExpenseBank.findByIdAndUpdate(req.params.id, { name }, { new: true });
    if (!bank) return sendError(res, "Bank not found", 404);
    return sendSuccess(res, bank, "Bank updated");
  } catch (error: any) {
    if (error?.code === 11000) {
      return sendError(res, "A bank with this name already exists", 409);
    }
    console.error("Update expense bank error:", error);
    return sendError(res, "Failed to update bank", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const bank = await ExpenseBank.findByIdAndDelete(req.params.id);
    if (!bank) return sendError(res, "Bank not found", 404);
    return sendSuccess(res, null, "Bank removed");
  } catch (error) {
    console.error("Delete expense bank error:", error);
    return sendError(res, "Failed to remove bank", 500);
  }
});

export default router;
