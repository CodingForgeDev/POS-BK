/**
 * ZKTeco ADMS (iClock) HTTP push receiver — FALLBACK attendance ingestion path.
 *
 * The device pushes attendance logs to the server over HTTP (port 8081 / 4370).
 * This is the secondary path; the primary path is the TCP pull sync (zkPullService.ts).
 *
 * Responsibilities:
 *   - Parse raw ADMS tab-delimited attlog lines from the device HTTP POST body.
 *   - Build the iClock handshake response (ATTLOGStamp, ServerVer, etc.).
 *   - Forward parsed punches to the shared upsert layer (deviceAttendanceUpsert.ts).
 */
import { DateTime } from "luxon";
import { previewPlainTextForLog } from "../../lib/plainLogPreview";
import { getAppTimezone } from "../../lib/appTimezone";
import {
  devicePunchTypeFromRawStatus1,
  upsertDevicePunchToAttendance,
  type DeviceAttendancePunch,
  type DevicePunchType,
} from "../../lib/deviceAttendanceUpsert";

export type AdmsAttLogPunch = DeviceAttendancePunch;

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

// Strict "YYYY-MM-DD HH:mm:ss" (or space replaced by "T") — device wall-clock, treated as APP_TIMEZONE.
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
  // Interpret device wall-clock as business timezone (APP_TIMEZONE), matching ZK TCP pull normalizer.
  const dt = DateTime.fromObject(
    { year: y, month: mo, day: d, hour: h, minute: mi, second: s },
    { zone: getAppTimezone() }
  );
  if (!dt.isValid) return null;
  // Reject dates where luxon normalised overflowed components (e.g. Feb 30 → Mar 2).
  if (dt.year !== y || dt.month !== mo || dt.day !== d || dt.hour !== h || dt.minute !== mi || dt.second !== s) {
    return null;
  }
  return dt.toJSDate();
}

function parseIntOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

export function parseAdmsAttLog(rawBody: string): { punches: AdmsAttLogPunch[]; receivedLines: number } {
  const lines = splitAdmsBodyIntoLines(rawBody);
  const receivedLines = lines.length;

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

    const punchType = devicePunchTypeFromRawStatus1(status1);

    punches.push({
      deviceUserId,
      timestamp: ts,
      punchType,
      rawStatus1: status1,
    });
  }

  return { punches, receivedLines };
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
    const result = await upsertDevicePunchToAttendance(punch);
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
