import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Setting from "../models/Setting";

const router: Router = Router();

router.get("/", authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const settings = await (Setting as any).find({}).lean();
    const result: Record<string, any> = {};
    for (const s of settings as any[]) {
      result[s.key] = s.value;
    }
    return sendSuccess(res, result);
  } catch (error) {
    return sendError(res, "Failed to fetch settings", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const ops = Object.entries(req.body).map(([key, value]) => ({
      updateOne: {
        filter: { key },
        update: { $set: { key, value } },
        upsert: true,
      },
    }));
    if (ops.length > 0) await (Setting as any).bulkWrite(ops);
    return sendSuccess(res, null, "Settings saved successfully");
  } catch (error) {
    return sendError(res, "Failed to save settings", 500);
  }
});

export default router;
