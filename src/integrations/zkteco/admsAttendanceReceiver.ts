import Employee from "../../models/Employee";
import Attendance from "../../models/Attendance";
import { computeHoursWorked, startOfLocalDay } from "../../lib/attendanceHelpers";
import { previewPlainTextForLog } from "../../lib/plainLogPreview";

export type AdmsPunchType = "in" | "out";

export interface AdmsAttLogPunch {
  deviceUserId: string;
  timestamp: Date;
  // punchType can be null if the device uses a different status value than our default mapping.
  // In that case we infer in/out from existing Attendance data.
  punchType: AdmsPunchType | null;
  rawStatus1?: number | null;
}

export interface AdmsReceiverResult {
  receivedLines: number;
  punchesParsed: number;
  savedPunches: number;
  skipped: number;
  employeeNotFound: number;
  unknownPunchType: number;
}

/** ADMS text records are separated by newlines only (never commas — commas can appear inside fields). */
export function splitAdmsBodyIntoLines(rawBody: string): string[] {
  return rawBody
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Strict "YYYY-MM-DD HH:mm:ss" (or space replaced by "T") — local wall time, not UTC.
const ADMS_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

function parseAdmsTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = trimmed.match(ADMS_DATETIME_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if ([y, mo, d, h, mi, s].some((n) => Number.isNaN(n))) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ts = new Date(y, mo - 1, d, h, mi, s);
  if (
    ts.getFullYear() !== y ||
    ts.getMonth() !== mo - 1 ||
    ts.getDate() !== d ||
    ts.getHours() !== h ||
    ts.getMinutes() !== mi ||
    ts.getSeconds() !== s
  ) {
    return null;
  }
  return ts;
}

function parseIntOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/** Maps device verify state (status1) to in/out using env-configured values. */
function inferPunchTypeFromDeviceStatus(
  status1: number | null,
  inValue: number,
  outValue: number
): AdmsPunchType | null {
  if (status1 === null) return null;
  if (status1 === inValue) return "in";
  if (status1 === outValue) return "out";
  return null;
}

type AttendanceClockFields = {
  clockIn: Date | null | undefined;
  clockOut: Date | null | undefined;
  hoursWorked?: number;
};

/** When the device omits or uses unknown status codes, derive in/out from existing row + timestamps. */
function resolveEffectivePunchType(punch: AdmsAttLogPunch, existing: AttendanceClockFields | null): AdmsPunchType | null {
  if (punch.punchType) return punch.punchType;
  if (!existing) return "in";
  if (!existing.clockIn) return "in";
  if (!existing.clockOut) return "out";
  if (punch.timestamp <= existing.clockIn) return "in";
  if (punch.timestamp >= existing.clockOut) return "out";
  return null;
}

/** Earlier clock-in wins (device may resend corrections). */
function tryApplyDeviceClockIn(existing: AttendanceClockFields, punchTs: Date): boolean {
  if (!existing.clockIn || punchTs.getTime() < existing.clockIn.getTime()) {
    existing.clockIn = punchTs;
    return true;
  }
  return false;
}

/**
 * Later clock-out wins, but never record out before the day's clock-in (out-of-order uploads).
 */
function tryApplyDeviceClockOut(
  existing: AttendanceClockFields,
  punchTs: Date
): { applied: boolean; rejectReason?: "out_before_in" } {
  if (existing.clockIn && punchTs.getTime() < existing.clockIn.getTime()) {
    return { applied: false, rejectReason: "out_before_in" };
  }
  if (!existing.clockOut || punchTs.getTime() > existing.clockOut.getTime()) {
    existing.clockOut = punchTs;
    return { applied: true };
  }
  return { applied: false };
}

function refreshHoursWorkedField(existing: AttendanceClockFields): boolean {
  const hours = computeHoursWorked(existing.clockIn ?? null, existing.clockOut ?? null);
  if (existing.hoursWorked !== hours) {
    existing.hoursWorked = hours;
    return true;
  }
  return false;
}

export function parseAdmsAttLog(rawBody: string): { punches: AdmsAttLogPunch[]; receivedLines: number } {
  const lines = splitAdmsBodyIntoLines(rawBody);
  const receivedLines = lines.length;

  const inValue = Number.parseInt(process.env.ZKTECO_CLOCK_IN_VALUE ?? "0", 10);
  const outValue = Number.parseInt(process.env.ZKTECO_CLOCK_OUT_VALUE ?? "1", 10);

  const punches: AdmsAttLogPunch[] = [];

  for (const line of lines) {
    // Example (tab-separated):
    // PIN<TAB>YYYY-MM-DD HH:mm:ss<TAB>status1<TAB>status2<...>
    const fields = line.split("\t");
    if (fields.length < 3) continue;

    const deviceUserId = fields[0]?.trim();
    const ts = parseAdmsTimestamp(fields[1]);
    const status1 = parseIntOrNull(fields[2]);
    if (!deviceUserId || !ts) continue;

    const punchType = inferPunchTypeFromDeviceStatus(status1, inValue, outValue);

    punches.push({
      deviceUserId,
      timestamp: ts,
      punchType,
      rawStatus1: status1,
    });
  }

  return { punches, receivedLines };
}

async function upsertPunchToAttendance(punch: AdmsAttLogPunch): Promise<{ saved: boolean; reason?: string }> {
  // Prefer explicit deviceUserId mapping (clean + stable), but keep fallback for older data.
  const employee = await Employee.findOne({
    $or: [{ deviceUserId: punch.deviceUserId }, { employeeId: punch.deviceUserId }],
  }).select("_id");
  if (!employee?._id) return { saved: false, reason: "employee_not_found" };

  const day = startOfLocalDay(punch.timestamp);

  const existing = await Attendance.findOne({ employee: employee._id, date: day });

  const effectiveType = resolveEffectivePunchType(punch, existing);

  if (!effectiveType) return { saved: false, reason: "unknown_punch_type" };

  if (!existing) {
    if (effectiveType === "out") {
      return { saved: false, reason: "orphan_out" };
    }

    const created = new Attendance({
      employee: employee._id,
      date: day,
      clockIn: punch.timestamp,
      clockOut: null,
      hoursWorked: 0,
      status: "present",
      notes: "",
    });

    await created.save();
    return { saved: true };
  }

  let changed = false;

  if (effectiveType === "in") {
    if (tryApplyDeviceClockIn(existing, punch.timestamp)) changed = true;
  } else {
    const out = tryApplyDeviceClockOut(existing, punch.timestamp);
    if (out.rejectReason) return { saved: false, reason: out.rejectReason };
    if (out.applied) changed = true;
  }

  if (refreshHoursWorkedField(existing)) changed = true;

  if (changed) await existing.save();
  return { saved: changed };
}

export async function handleAdmsAttLogPost(rawBody: string): Promise<AdmsReceiverResult> {
  if (process.env.ZKTECO_RECEIVER_LOG === "1") {
    // eslint-disable-next-line no-console
    console.log(`[ZKTeco] attlog recv bytes=${rawBody.length} preview=${previewPlainTextForLog(rawBody, 240)}`);
  }
  const { punches, receivedLines } = parseAdmsAttLog(rawBody);

  const parsedPunches = punches.length;
  const unknownPunchType = punches.filter((p) => !p.punchType).length;

  let savedPunches = 0;
  let employeeNotFound = 0;
  let skipped = 0;

  for (const punch of punches) {
    const result = await upsertPunchToAttendance(punch);
    if (result.saved) savedPunches += 1;
    else if (result.reason === "employee_not_found") employeeNotFound += 1;
    else skipped += 1;
  }

  return {
    receivedLines,
    punchesParsed: parsedPunches,
    savedPunches,
    skipped,
    employeeNotFound,
    unknownPunchType,
  };
}

/**
 * Stamp-related ADMS options (pushver ~2.x).
 * - ATTLOGStamp=0: ask device to sync attendance (full vs delta depends on firmware).
 * - OPERLOGStamp / BIODATAStamp: keep high to avoid noisy non-attendance sync loops on MB460-class devices.
 * - OpStamp: server “operation” time in seconds (devices use for relative scheduling).
 * Do not add legacy v1-only `Stamp=` here — confuses pushver 2.x handshakes.
 */
function buildAdmsHandshakeStampSection(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    `ATTLOGStamp=0\r\n` +
    `OPERLOGStamp=9999\r\n` +
    `BIODATAStamp=9999\r\n` +
    `ServerVer=2.0\r\n` +
    `OpStamp=${nowSec}\r\n`
  );
}

export function buildAdmsHandshakeResponse(sn: string | undefined): string {
  return (
    `GET OPTION FROM: ${sn ?? ""}\r\n` +
    buildAdmsHandshakeStampSection() +
    `ErrorDelay=60\r\n` +
    `Delay=30\r\n` +
    `ResLogDay=18250\r\n` +
    `ResLogDelCount=10000\r\n` +
    `ResLogCount=50000\r\n` +
    `TransTimes=00:00;14:05\r\n` +
    `TransInterval=1\r\n` +
    `TransFlag=1111000000\r\n` +
    `Realtime=1\r\n` +
    `Encrypt=0\r\n`
  );
}

