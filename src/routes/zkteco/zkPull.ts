import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest, requireRole } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../lib/utils";
import { getZkPullConfig, isZkPullDeviceConfigured } from "../../integrations/zkteco/zkPullConfig";
import { zkTestDeviceConnection } from "../../integrations/zkteco/zkClient";
import {
  runZkPullSync,
  getZkPullSyncStatus,
  syncZkDeviceUsersFromDevice,
  getCachedZkDeviceUsers,
} from "../../integrations/zkteco/zkPullService";

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
      // Attempt a live TCP pull first (works when the server can directly reach the device).
      // Use a shorter connect timeout so the route responds in reasonable time when the device
      // is unreachable (e.g. local network — server can't reach it over internet).
      const result = await runZkPullSync({ connectTimeoutMs: 4_000 });
      if (result.ok) {
        return sendSuccess(res, result, "ZK pull sync completed");
      }

      // TCP sync failed (device not reachable from server) — fall back to last sync state
      // written by the office-PC local script (zk-sync.js → zkpullsyncstates collection).
      const status = await getZkPullSyncStatus();
      const state  = status.state as Record<string, unknown> | null;

      if (!state?.lastSyncAt) {
        return res.status(400).json({
          success: false,
          message:
            "Biometric device is not reachable from the server, and no local sync has been " +
            "performed yet. Run the \"Sync Biometric Users\" shortcut on the office PC first.",
          data: { ok: false, logsFetched: 0, logsProcessed: 0, logsSkipped: 0, employeeNotFound: 0 },
        });
      }

      // Return the last local-script sync stats so the frontend can display them.
      return sendSuccess(
        res,
        {
          ok:               true,
          source:           "local-script",
          lastSyncAt:       state.lastSyncAt,
          logsFetched:      state.logsFetched  ?? 0,
          logsProcessed:    state.logsProcessed ?? 0,
          logsSkipped:      state.logsSkipped  ?? 0,
          employeeNotFound: state.employeeNotFound ?? 0,
          unknownPunchType: state.unknownPunchType  ?? 0,
        },
        `Attendance data is up to date — last synced by office PC at ${new Date(state.lastSyncAt as Date).toLocaleString()}`
      );
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
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const refresh =
        String(req.query.refresh ?? "").toLowerCase() === "1" ||
        String(req.query.refresh ?? "").toLowerCase() === "true";
      const result = refresh
        ? await syncZkDeviceUsersFromDevice()
        : await getCachedZkDeviceUsers();
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
            ? `Loaded ${users.length} cached user(s)`
            : "No cached users yet";

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
