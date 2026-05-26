import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest, requireRole } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../lib/utils";
import { getZkPullConfig, isZkPullDeviceConfigured } from "../../integrations/zkteco/zkPullConfig";
import { zkTestDeviceConnection } from "../../integrations/zkteco/zkClient";
import { runZkPullSync, getZkPullSyncStatus, syncZkDeviceUsersFromDevice } from "../../integrations/zkteco/zkPullService";

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
 * Fetches enrolled users from the ZKTeco device (TCP), caches in MongoDB, returns the list.
 */
router.get(
  "/device-users",
  authenticate,
  requireRole("admin", "manager"),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await syncZkDeviceUsersFromDevice();
      const { users, lastSyncedAt, source, deviceError } = result;

      if (users.length === 0 && deviceError) {
        return res.status(502).json({
          success: false,
          message: `Could not reach device: ${deviceError}`,
          data: { users: [], count: 0, lastSyncedAt, source, deviceError },
        });
      }

      const message =
        source === "device"
          ? `Loaded ${users.length} user(s) from device`
          : users.length
            ? `Loaded ${users.length} cached user(s) (device unreachable)`
            : "No users found on device";

      return sendSuccess(
        res,
        {
          users,
          count: users.length,
          lastSyncedAt,
          source,
          deviceError: deviceError ?? null,
        },
        message
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch device users";
      return sendError(res, msg, 500);
    }
  }
);

export default router;
