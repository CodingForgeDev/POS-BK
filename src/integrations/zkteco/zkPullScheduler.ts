/**
 * ZKTeco TCP pull-sync scheduler.
 *
 * Owns the server-startup lifecycle for the primary attendance ingestion path:
 *   1. Log a human-readable startup summary of env/device config.
 *   2. Start the background interval sync (ZK_PULL_INTERVAL_SECONDS).
 *   3. Optionally run one sync shortly after startup (ZK_PULL_SYNC_ON_STARTUP).
 *
 * Called once from src/index.ts after MongoDB connects.
 * All business logic lives in zkPullService.ts — this file only owns scheduling.
 */

import { getZkPullConfig, isZkPullDeviceConfigured } from "./zkPullConfig";
import { runZkPullSync } from "./zkPullService";

function logZkPullStartupSummary(): void {
  const cfg = getZkPullConfig();
  const dev = isZkPullDeviceConfigured(cfg);
  // eslint-disable-next-line no-console
  console.log(
    `[ZK pull] device: ${dev.ok ? "configured" : "not configured"}${dev.reason ? ` (${dev.reason})` : ""} | ZK_PULL_ENABLED=${cfg.enabled} | interval=${cfg.intervalSeconds || 0}s | ZK_PULL_SYNC_ON_STARTUP=${cfg.syncOnStartup}`
  );
  // eslint-disable-next-line no-console
  console.log(
    "[ZK pull] comm key: node-zklib does not send it on CMD_CONNECT; this app sends CMD_AUTH after connect when ZK_DEVICE_PASSWORD is set (see zkTcpAuth.ts)."
  );
}

function startZkPullIntervalScheduler(): void {
  const cfg = getZkPullConfig();
  if (!cfg.enabled) {
    // eslint-disable-next-line no-console
    console.log("[ZK pull] background scheduler off (set ZK_PULL_ENABLED=1 and ZK_PULL_INTERVAL_SECONDS>=60)");
    return;
  }
  const dev = isZkPullDeviceConfigured(cfg);
  if (!dev.ok || !cfg.intervalSeconds || cfg.intervalSeconds < 60) {
    return;
  }
  const ms = cfg.intervalSeconds * 1000;
  setInterval(() => {
    runZkPullSync().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ZK pull] scheduled sync error:", err);
    });
  }, ms);
  // eslint-disable-next-line no-console
  console.log(`[ZK pull] background sync every ${cfg.intervalSeconds}s (ZK_PULL_INTERVAL_SECONDS)`);
}

function scheduleZkPullStartupSync(): void {
  const cfg = getZkPullConfig();
  if (!cfg.syncOnStartup) return;
  const dev = isZkPullDeviceConfigured(cfg);
  if (!dev.ok) return;
  setTimeout(() => {
    runZkPullSync().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ZK pull] startup sync error:", err);
    });
  }, 4000);
}

/**
 * Entry point called from src/index.ts after MongoDB connects.
 * Logs config, starts interval scheduler, and queues the optional startup sync.
 */
export function initZkPull(): void {
  logZkPullStartupSummary();
  startZkPullIntervalScheduler();
  scheduleZkPullStartupSync();
}
