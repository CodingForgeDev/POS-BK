import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest, requireRole } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../lib/utils";
import { getZkPullConfig, isZkPullDeviceConfigured } from "../../integrations/zkteco/zkPullConfig";
import { zkTestDeviceConnection } from "../../integrations/zkteco/zkClient";
import { runZkPullSync, getZkPullSyncStatus } from "../../integrations/zkteco/zkPullService";
import { connectDB } from "../../lib/mongodb";
import ZkDeviceUser from "../../models/ZkDeviceUser.model";

const router: Router = Router();

router.get(
  "/status",
  authenticate,
  requireRole("admin", "manager"),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const status = await getZkPullSyncStatus();
      return sendSuccess(res, status);
    } catch {
      return sendError(res, "Failed to read ZK pull status", 500);
    }
  }
);

router.post(
  "/sync",
  authenticate,
  requireRole("admin", "manager"),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await runZkPullSync();
      if (!result.ok) {
        return res.status(400).json({
          success: false,
          message: result.message || "ZK pull sync failed",
          data: result,
        });
      }
      return sendSuccess(res, result, "ZK pull sync completed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ZK pull sync failed";
      return sendError(res, msg, 500);
    }
  }
);

router.get(
  "/test",
  authenticate,
  requireRole("admin", "manager"),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const cfg = getZkPullConfig();
      const dev = isZkPullDeviceConfigured(cfg);
      if (!dev.ok) {
        return sendError(res, dev.reason || "ZK device not configured (set ZK_DEVICE_IP, etc.)", 400);
      }
      const result = await zkTestDeviceConnection(cfg);
      if (result.ok === false) {
        return res.status(502).json({
          success: false,
          message: result.error,
          data: { connected: false, diagnostics: result.diagnostics ?? null },
        });
      }
      return sendSuccess(
        res,
        { connected: true, info: result.info, diagnostics: result.diagnostics },
        "ZK device reachable"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Device test failed";
      return sendError(res, msg, 500);
    }
  }
);

/**
 * GET /api/zk-pull/device-users
 * Returns the ZKTeco user list previously synced to MongoDB via the local zk-sync script.
 * No direct device connection needed — reads from the zkdeviceusers collection.
 */
router.get(
  "/device-users",
  authenticate,
  requireRole("admin", "manager"),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      await connectDB();
      const users = await ZkDeviceUser.find({}).sort({ userId: 1 }).lean();

      // Find the most recent sync time across all user records
      const latest = await ZkDeviceUser.findOne({}).sort({ syncedAt: -1 }).lean();
      const lastSyncedAt = latest?.syncedAt ?? null;

      return sendSuccess(
        res,
        {
          users: users.map((u) => ({
            userId: u.userId,
            name:   u.name,
            uid:    u.uid,
            role:   u.role,
          })),
          count: users.length,
          lastSyncedAt,
        },
        users.length
          ? "Device users loaded from last sync"
          : "No synced users yet — run the zk-sync script on the office PC"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch device users";
      return sendError(res, msg, 500);
    }
  }
);

export default router;
