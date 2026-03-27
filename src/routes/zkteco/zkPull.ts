import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest, requireRole } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../lib/utils";
import { getZkPullConfig, isZkPullDeviceConfigured } from "../../integrations/zkteco/zkPullConfig";
import { zkTestDeviceConnection, fetchZkDeviceUsers } from "../../integrations/zkteco/zkClient";
import { runZkPullSync, getZkPullSyncStatus } from "../../integrations/zkteco/zkPullService";

const router = Router();

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
        {
          connected: true,
          info: result.info,
          diagnostics: result.diagnostics,
        },
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
 * Returns the user list enrolled on the ZKTeco device.
 * Each user has { userId, name, uid, role } — `userId` is the PIN to set as Employee.deviceUserId.
 */
router.get(
  "/device-users",
  authenticate,
  requireRole("admin", "manager"),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const cfg = getZkPullConfig();
      const dev = isZkPullDeviceConfigured(cfg);
      if (!dev.ok) {
        return sendError(res, dev.reason || "ZK device not configured (set ZK_DEVICE_IP, etc.)", 400);
      }
      const users = await fetchZkDeviceUsers(cfg);
      return sendSuccess(res, { users, count: users.length }, "Device users fetched");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch device users";
      return sendError(res, msg, 500);
    }
  }
);

export default router;
