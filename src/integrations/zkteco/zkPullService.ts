/**
 * ZKTeco TCP pull-sync service — PRIMARY attendance ingestion path.
 *
 * Orchestrates one complete sync cycle:
 *   1. Fetch raw 40-byte attendance buffers from device (zkClient.ts).
 *   2. Decode + timezone-correct each record (zkNormalizer.ts).
 *   3. Sort records by (employee, timestamp) — device buffer is NOT chronological.
 *   4. Skip already-processed records (ZkPullDedupe fingerprint check).
 *   5. Upsert each punch into the Attendance collection (deviceAttendanceUpsert.ts).
 *   6. Persist sync-run metadata (ZkPullSyncState).
 *
 * Scheduling (startup + interval) lives in zkPullScheduler.ts.
 * Shared clock-in/out upsert logic lives in lib/deviceAttendanceUpsert.ts.
 */
import { connectDB } from "../../lib/mongodb";
import {
  devicePunchTypeFromRawStatus1,
  upsertDevicePunchToAttendance,
  type DeviceAttendancePunch,
} from "../../lib/deviceAttendanceUpsert";
import ZkPullDedupe from "../../models/ZkPullDedupe";
import ZkPullSyncState from "../../models/ZkPullSyncState";
import { fetchZkAttendanceRecordBuffers } from "./zkClient";
import { decodeZkAttendanceRecord40, zkPullFingerprint } from "./zkNormalizer";
import {
  getZkPullConfig,
  isZkPullConfigReady,
  isZkPullDeviceConfigured,
  type ZkPullConfig,
} from "./zkPullConfig";
import type { ZkPullSyncDiagnostics, ZkPullSyncRunResult } from "./zkTypes";

const SYNC_DOC_ID = "zk-pull";

let syncInFlight = false;

function zeroDiagnostics(): ZkPullSyncDiagnostics {
  return {
    rawRecordsFetched: 0,
    normalizedOk: 0,
    parseFailed: 0,
    dedupeSkipped: 0,
    upsertApplied: 0,
    upsertNoop: 0,
    employeeNotFound: 0,
    unknownPunchType: 0,
    otherRejected: 0,
  };
}

function emptyResult(message?: string): ZkPullSyncRunResult {
  const z = zeroDiagnostics();
  return {
    ok: false,
    message,
    logsFetched: 0,
    logsProcessed: 0,
    logsSkipped: 0,
    employeeNotFound: 0,
    unknownPunchType: 0,
    diagnostics: z,
  };
}

function zkPullLog(cfg: ZkPullConfig, msg: string): void {
  if (cfg.debug) {
    // eslint-disable-next-line no-console
    console.log(`[ZK pull] ${msg}`);
  }
}

async function persistSyncState(
  patch: Partial<{
    lastSuccess: boolean;
    logsFetched: number;
    logsProcessed: number;
    logsSkipped: number;
    employeeNotFound: number;
    unknownPunchType: number;
    lastError: string | null;
  }>
): Promise<void> {
  await ZkPullSyncState.findOneAndUpdate(
    { _id: SYNC_DOC_ID },
    {
      $set: {
        lastSyncAt: new Date(),
        ...patch,
      },
    },
    { upsert: true }
  );
}

function shouldRecordDedupeAfterUpsert(res: { saved: boolean; reason?: string }): boolean {
  if (res.saved) return true;
  if (res.saved === false && !res.reason) return true;
  return false;
}

/** Single source of truth for the "skipped" counter used in run results and sync state. */
function computeLogsSkipped(d: ZkPullSyncDiagnostics): number {
  return d.parseFailed + d.dedupeSkipped + d.upsertNoop + d.otherRejected + d.employeeNotFound + d.unknownPunchType;
}

function buildRunResult(d: ZkPullSyncDiagnostics): ZkPullSyncRunResult {
  const logsSkipped = computeLogsSkipped(d);
  return {
    ok: true,
    logsFetched: d.rawRecordsFetched,
    logsProcessed: d.upsertApplied,
    logsSkipped,
    employeeNotFound: d.employeeNotFound,
    unknownPunchType: d.unknownPunchType,
    diagnostics: d,
  };
}

/**
 * Pull attendance rows from the device, dedupe, map employees, upsert into Attendance.
 * Does **not** require `ZK_PULL_ENABLED` — only `ZK_DEVICE_IP` (+ valid port/timeout) so manual `/api/zk-pull/sync` works for debugging.
 * Background scheduler still checks `ZK_PULL_ENABLED` in `index.ts`.
 */
export async function runZkPullSync(override?: Partial<ZkPullConfig>): Promise<ZkPullSyncRunResult> {
  if (syncInFlight) {
    return emptyResult("sync_already_in_progress");
  }

  const base = getZkPullConfig();
  // Spread base then override; only deviceIp needs post-processing (trim).
  const cfg: ZkPullConfig = {
    ...base,
    ...override,
    deviceIp: (override?.deviceIp ?? base.deviceIp).trim(),
  };

  const ready = isZkPullDeviceConfigured(cfg);
  if (!ready.ok) {
    return emptyResult(ready.reason);
  }

  syncInFlight = true;
  const d = zeroDiagnostics();
  /** IDs already warned about this run — avoids thousands of identical log lines. */
  const notFoundWarnedIds = new Set<string>();

  try {
    await connectDB();

    zkPullLog(cfg, `sync start ip=${cfg.deviceIp} port=${cfg.devicePort} commKeySet=${Boolean(cfg.devicePassword?.trim())}`);

    const buffers = await fetchZkAttendanceRecordBuffers(cfg, { debug: cfg.debug });
    d.rawRecordsFetched = buffers.length;
    zkPullLog(cfg, `fetched raw 40-byte records: ${d.rawRecordsFetched}`);

    // Decode all records first, then sort by (deviceUserId, timestamp) so that
    // for each employee the earliest scan is always processed before later ones.
    // Device buffer is ordered by internal sequence number, NOT by clock time —
    // processing out-of-order caused clock-out to be saved as clock-in and vice versa.
    const decodedLogs = buffers
      .map((buf) => decodeZkAttendanceRecord40(buf, cfg.deviceTimeOffsetMinutes))
      .filter((log): log is NonNullable<typeof log> => log !== null);

    d.parseFailed = buffers.length - decodedLogs.length;

    decodedLogs.sort((a, b) => {
      if (a.deviceUserId < b.deviceUserId) return -1;
      if (a.deviceUserId > b.deviceUserId) return 1;
      return a.timestamp.getTime() - b.timestamp.getTime();
    });

    // Pre-compute fingerprints and fetch all already-seen ones in a single $in query.
    // Avoids N individual findOne round-trips (one per record) on every sync cycle.
    const decodedWithFp = decodedLogs.map((log) => ({ log, fingerprint: zkPullFingerprint(log) }));
    const allFingerprints = decodedWithFp.map((x) => x.fingerprint);
    const existingDocs = await ZkPullDedupe
      .find({ fingerprint: { $in: allFingerprints } })
      .select("fingerprint")
      .lean();
    const seenFingerprints = new Set(existingDocs.map((doc) => doc.fingerprint));

    for (const { log, fingerprint } of decodedWithFp) {
      d.normalizedOk += 1;

      if (seenFingerprints.has(fingerprint)) {
        d.dedupeSkipped += 1;
        continue;
      }

      const punch: DeviceAttendancePunch = {
        deviceUserId: log.deviceUserId,
        timestamp: log.timestamp,
        punchType: devicePunchTypeFromRawStatus1(log.rawStatus),
        rawStatus1: log.rawStatus,
      };

      const res = await upsertDevicePunchToAttendance(punch);

      // Log infer only when employee was found AND punch type had to be inferred (not noisy for unmapped users).
      if (cfg.debug && punch.punchType === null && res.reason !== "employee_not_found") {
        zkPullLog(
          cfg,
          `infer punch user=${log.deviceUserId} rawStatus=${String(log.rawStatus)} verifyMode=${String(log.verifyMode)} → result=${res.saved ? "saved" : (res.reason ?? "noop")}`
        );
      }

      if (res.saved) {
        d.upsertApplied += 1;
      } else if (res.reason === "employee_not_found") {
        d.employeeNotFound += 1;
        if (cfg.debug && !notFoundWarnedIds.has(log.deviceUserId)) {
          notFoundWarnedIds.add(log.deviceUserId);
          zkPullLog(cfg, `employee_not_found deviceUserId=${log.deviceUserId} — set Employee.deviceUserId to this PIN in the edit dialog`);
        }
      } else if (res.reason === "unknown_punch_type") {
        // TODO: dead branch — resolveEffectivePunchType no longer returns null;
        // remove unknownPunchType tracking in a future cleanup pass.
        d.unknownPunchType += 1;
      } else if (!res.reason) {
        d.upsertNoop += 1;
      } else {
        d.otherRejected += 1;
        if (cfg.debug) {
          zkPullLog(cfg, `rejected user=${log.deviceUserId} reason=${res.reason ?? "unknown"}`);
        }
      }

      if (shouldRecordDedupeAfterUpsert(res)) {
        try {
          await ZkPullDedupe.create({ fingerprint });
        } catch (e: unknown) {
          const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: number }).code : undefined;
          if (code !== 11000) throw e;
        }
      }
    }

    const summary = buildRunResult(d);

    await persistSyncState({
      lastSuccess: true,
      logsFetched: d.rawRecordsFetched,
      logsProcessed: d.upsertApplied,
      logsSkipped: summary.logsSkipped,
      employeeNotFound: d.employeeNotFound,
      unknownPunchType: d.unknownPunchType,
      lastError: null,
    });

    zkPullLog(
      cfg,
      `sync done raw=${d.rawRecordsFetched} normOk=${d.normalizedOk} parseFail=${d.parseFailed} dedupe=${d.dedupeSkipped} applied=${d.upsertApplied} noop=${d.upsertNoop} noEmp=${d.employeeNotFound} unknownType=${d.unknownPunchType} other=${d.otherRejected}`
    );
    if (notFoundWarnedIds.size > 0) {
      zkPullLog(
        cfg,
        `unmapped device IDs (set Employee.deviceUserId via Edit dialog): [${[...notFoundWarnedIds].join(", ")}]`
      );
    }

    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failedSkipped = computeLogsSkipped(d);
    await persistSyncState({
      lastSuccess: false,
      logsFetched: d.rawRecordsFetched,
      logsProcessed: d.upsertApplied,
      logsSkipped: failedSkipped,
      employeeNotFound: d.employeeNotFound,
      unknownPunchType: d.unknownPunchType,
      lastError: msg,
    });
    zkPullLog(cfg, `sync FAILED: ${msg}`);
    return {
      ok: false,
      message: msg,
      logsFetched: d.rawRecordsFetched,
      logsProcessed: d.upsertApplied,
      logsSkipped: failedSkipped,
      employeeNotFound: d.employeeNotFound,
      unknownPunchType: d.unknownPunchType,
      diagnostics: d,
    };
  } finally {
    syncInFlight = false;
  }
}

export async function getZkPullSyncStatus(): Promise<{
  config: Omit<ReturnType<typeof getZkPullConfig>, "devicePassword"> & { devicePasswordSet: boolean };
  deviceConfigured: ReturnType<typeof isZkPullDeviceConfigured>;
  pullEnabled: boolean;
  /** Legacy: enabled && device configured. */
  ready: ReturnType<typeof isZkPullConfigReady>;
  /** True when `node-zklib` TCP connect runs; comm key is applied separately via CMD_AUTH (see zkTcpAuth). */
  nodeZklibCommKeyOnConnect: false;
  state: Record<string, unknown> | null;
}> {
  await connectDB();
  const full = getZkPullConfig();
  const { devicePassword, ...rest } = full;
  const deviceConfigured = isZkPullDeviceConfigured(full);
  const doc = await ZkPullSyncState.findById(SYNC_DOC_ID).lean();
  return {
    config: { ...rest, devicePasswordSet: Boolean(devicePassword) },
    deviceConfigured,
    pullEnabled: full.enabled,
    ready: isZkPullConfigReady(full),
    nodeZklibCommKeyOnConnect: false,
    state: doc ? (doc as Record<string, unknown>) : null,
  };
}
