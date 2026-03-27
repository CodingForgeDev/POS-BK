// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decodeRecordData40 } = require("node-zklib/utils") as {
  decodeRecordData40: (buf: Buffer) => { userSn: number; deviceUserId: string; recordTime: Date };
};

import { createHash } from "crypto";
import { DateTime } from "luxon";
import { getAppTimezone } from "../../lib/appTimezone";
import type { ZkNormalizedAttendanceLog } from "./zkTypes";

const RECORD_SIZE = 40;

/**
 * node-zklib decodes timestamps with `new Date(year, month, day, h, m, s)`.
 * That constructor treats the values as LOCAL (server OS) time — but the device
 * simply stores wall-clock numbers with no timezone. We reinterpret those numbers
 * as business-timezone wall-clock time using APP_TIMEZONE so that attendance dates
 * are always computed in the correct business zone regardless of server OS timezone.
 *
 * Example (APP_TIMEZONE=Asia/Karachi, UTC+5):
 *   Device stored: 2026-03-26 21:00  (wall clock on device)
 *   node-zklib returns: new Date("2026-03-26T21:00:00")  ← server-local interpretation
 *   We reinterpret: DateTime(2026, 3, 26, 21, 0, 0, Asia/Karachi) = correct UTC epoch
 */
function reinterpretDeviceTimeInBusinessZone(rawDate: Date): Date {
  const tz = getAppTimezone();
  // Extract raw year/month/day/hour/minute/second from node-zklib's local Date
  const y = rawDate.getFullYear();
  const mo = rawDate.getMonth() + 1; // luxon months are 1-based
  const d = rawDate.getDate();
  const h = rawDate.getHours();
  const mi = rawDate.getMinutes();
  const s = rawDate.getSeconds();
  // Re-create as business-timezone wall-clock
  const dt = DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi, second: s }, { zone: tz });
  return dt.isValid ? dt.toJSDate() : rawDate;
}

/**
 * Decode a 40-byte attendance record from the device buffer.
 *
 * @param offsetMinutes - minutes to add AFTER timezone reinterpretation.
 *   Use only when the device hardware clock itself is wrong (e.g. -180 = 3 h ahead).
 *   If device clock is correct, keep at 0.
 */
export function decodeZkAttendanceRecord40(
  buf: Buffer,
  offsetMinutes = 0
): ZkNormalizedAttendanceLog | null {
  if (!buf || buf.length < RECORD_SIZE) return null;
  const base = decodeRecordData40(buf.subarray(0, RECORD_SIZE));
  const deviceUserId = String(base.deviceUserId ?? "").trim();
  if (!deviceUserId || !base.recordTime || Number.isNaN(base.recordTime.getTime())) return null;

  let verifyMode: number | null = null;
  let rawStatus: number | null = null;
  try {
    verifyMode = buf.readUInt8(26);
    rawStatus = buf.readUInt8(31);
  } catch {
    verifyMode = null;
    rawStatus = null;
  }

  // Step 1: reinterpret raw device wall-clock as business timezone.
  let timestamp = reinterpretDeviceTimeInBusinessZone(base.recordTime);

  // Step 2: apply device hardware clock correction offset (if any).
  if (offsetMinutes !== 0) {
    timestamp = new Date(timestamp.getTime() + offsetMinutes * 60 * 1000);
  }

  return {
    deviceUserId,
    userSn: base.userSn,
    timestamp,
    rawStatus,
    verifyMode,
    source: "zk-pull",
  };
}

/** Stable idempotency key for a pulled punch (same physical row → same key). */
export function zkPullFingerprint(log: ZkNormalizedAttendanceLog): string {
  const ts = log.timestamp.getTime();
  const raw = log.rawStatus ?? "x";
  const vm = log.verifyMode ?? "x";
  const payload = `${log.userSn}|${log.deviceUserId}|${ts}|${raw}|${vm}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
