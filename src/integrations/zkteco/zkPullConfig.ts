/**
 * ZKTeco TCP pull-sync configuration.
 *
 * Reads env variables and exposes a typed ZkPullConfig object.
 * Single source of truth for all pull-sync settings — change .env, nothing else.
 *
 * Key variables: ZK_DEVICE_IP, ZK_PULL_ENABLED, ZK_PULL_INTERVAL_SECONDS,
 * ZK_DEVICE_TIME_OFFSET_MINUTES, APP_TIMEZONE (shared with attendance).
 */
export interface ZkPullConfig {
  enabled: boolean;
  deviceIp: string;
  devicePort: number;
  /**
   * ZKTeco communication key (decimal e.g. `1234`, or hex). Sent via CMD_AUTH after CMD_CONNECT
   * using the pyzk-compatible `make_commkey` algorithm — NOT handled by `node-zklib` itself.
   */
  devicePassword: string;
  intervalSeconds: number;
  timeoutMs: number;
  udpInPort: number;
  debug: boolean;
  /** If true, run one pull sync shortly after server startup (requires device configured). */
  syncOnStartup: boolean;
  skipCmdAuth: boolean;
  commAuthTicks: number;
  /**
   * Minutes to add to every decoded device timestamp (negative = subtract).
   * Use when the device clock is consistently ahead/behind by a fixed amount.
   * Example: device 3 h ahead → -180. Device correct → 0.
   */
  deviceTimeOffsetMinutes: number;
}

export function getZkPullConfig(): ZkPullConfig {
  const enabledRaw = process.env.ZK_PULL_ENABLED;
  const enabled = enabledRaw === "1" || enabledRaw === "true";
  const syncOnStartupRaw = process.env.ZK_PULL_SYNC_ON_STARTUP;
  const syncOnStartup = syncOnStartupRaw === "1" || syncOnStartupRaw === "true";
  const skipCmdAuth = process.env.ZK_SKIP_CMD_AUTH === "1" || process.env.ZK_SKIP_CMD_AUTH === "true";
  const commAuthTicks = Number.parseInt(process.env.ZK_COMM_AUTH_TICKS ?? "50", 10);
  const deviceTimeOffsetMinutes = Number.parseInt(process.env.ZK_DEVICE_TIME_OFFSET_MINUTES ?? "0", 10);

  return {
    enabled,
    deviceIp: (process.env.ZK_DEVICE_IP ?? "").trim(),
    devicePort: Number.parseInt(process.env.ZK_DEVICE_PORT ?? "4370", 10),
    devicePassword: process.env.ZK_DEVICE_PASSWORD ?? "",
    intervalSeconds: Number.parseInt(process.env.ZK_PULL_INTERVAL_SECONDS ?? "0", 10),
    timeoutMs: Number.parseInt(process.env.ZK_PULL_TIMEOUT_MS ?? "20000", 10),
    udpInPort: Number.parseInt(process.env.ZK_PULL_UDP_IN_PORT ?? "4000", 10),
    debug: process.env.ZK_PULL_DEBUG === "1" || process.env.ZK_PULL_DEBUG === "true",
    syncOnStartup,
    skipCmdAuth,
    commAuthTicks: Number.isFinite(commAuthTicks) ? Math.max(0, Math.min(255, commAuthTicks)) : 50,
    deviceTimeOffsetMinutes: Number.isFinite(deviceTimeOffsetMinutes) ? deviceTimeOffsetMinutes : 0,
  };
}

/** Device IP/port/timeout only — used for manual sync & TCP test (does not require ZK_PULL_ENABLED). */
export function isZkPullDeviceConfigured(cfg: ZkPullConfig): { ok: boolean; reason?: string } {
  if (!cfg.deviceIp) return { ok: false, reason: "ZK_DEVICE_IP is required" };
  if (!Number.isFinite(cfg.devicePort) || cfg.devicePort < 1 || cfg.devicePort > 65535) {
    return { ok: false, reason: "ZK_DEVICE_PORT must be a valid TCP port" };
  }
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 1000) {
    return { ok: false, reason: "ZK_PULL_TIMEOUT_MS should be at least 1000" };
  }
  return { ok: true };
}

/** Legacy: enabled + device configured (for UI hints / optional strict checks). */
export function isZkPullConfigReady(cfg: ZkPullConfig): { ok: boolean; reason?: string } {
  if (!cfg.enabled) return { ok: false, reason: "ZK_PULL_ENABLED is not set" };
  return isZkPullDeviceConfigured(cfg);
}
