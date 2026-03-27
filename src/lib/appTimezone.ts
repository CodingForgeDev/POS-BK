/**
 * Business timezone utilities.
 *
 * Single source of truth for timezone-aware date operations.
 * All attendance date boundaries (start-of-day) are computed in APP_TIMEZONE.
 *
 * To deploy in a different country: change APP_TIMEZONE in .env — nothing else.
 *
 * Uses luxon for reliable IANA timezone support.
 */

import { DateTime } from "luxon";

/**
 * Returns the configured IANA timezone string.
 * Falls back to "Asia/Karachi" if env is missing.
 */
export function getAppTimezone(): string {
  const tz = process.env.APP_TIMEZONE?.trim();
  if (!tz) return "Asia/Karachi";
  // Validate: luxon will return an invalid DateTime for unknown zones.
  const check = DateTime.now().setZone(tz);
  if (!check.isValid) {
    console.warn(`[appTimezone] Unknown APP_TIMEZONE "${tz}" — falling back to Asia/Karachi`);
    return "Asia/Karachi";
  }
  return tz;
}

/**
 * Returns the start-of-day (midnight) for a given Date in the business timezone,
 * as a plain JS Date (UTC epoch). This is what gets stored in MongoDB `date` field.
 *
 * Example (APP_TIMEZONE=Asia/Karachi, UTC+5):
 *   input: 2026-03-26T20:00:00Z (= 01:00 next day PKT)
 *   output: 2026-03-27T00:00:00 PKT expressed in UTC = 2026-03-26T19:00:00Z
 */
export function startOfBusinessDay(date: Date): Date {
  const tz = getAppTimezone();
  const dt = DateTime.fromJSDate(date, { zone: tz }).startOf("day");
  return dt.toJSDate();
}

/**
 * Parses a date string / Date into the start-of-day in the business timezone.
 * Returns null if input is invalid.
 */
export function parseBusinessDay(input: unknown): Date | null {
  if (input == null || input === "") return null;

  const tz = getAppTimezone();
  let dt: DateTime;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    dt = DateTime.fromJSDate(input, { zone: tz });
  } else if (typeof input === "string") {
    // "YYYY-MM-DD" from frontend date picker — treat as a wall-clock date in business TZ.
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
      dt = DateTime.fromISO(input.trim(), { zone: tz });
    } else {
      dt = DateTime.fromISO(input.trim(), { zone: tz });
      if (!dt.isValid) dt = DateTime.fromJSDate(new Date(input), { zone: tz });
    }
  } else {
    return null;
  }

  if (!dt.isValid) return null;
  return dt.startOf("day").toJSDate();
}

/**
 * Returns the last millisecond of the given Date's day in the business timezone.
 * Use for inclusive upper bounds on single-day attendance queries.
 */
export function endOfBusinessDay(date: Date): Date {
  const tz = getAppTimezone();
  return DateTime.fromJSDate(date, { zone: tz }).endOf("day").toJSDate();
}

/**
 * Returns midnight of the first day of the given month in the business timezone.
 * Month is 1-based (1 = January).
 */
export function startOfBusinessMonth(year: number, month: number): Date {
  const tz = getAppTimezone();
  return DateTime.fromObject({ year, month, day: 1 }, { zone: tz }).startOf("month").toJSDate();
}

/**
 * Returns the last millisecond of the last day of the given month in the business timezone.
 * Month is 1-based (1 = January).
 */
export function endOfBusinessMonth(year: number, month: number): Date {
  const tz = getAppTimezone();
  return DateTime.fromObject({ year, month, day: 1 }, { zone: tz }).endOf("month").toJSDate();
}

/**
 * Formats a Date for display/logging in the business timezone (ISO with offset).
 */
export function formatInBusinessTz(date: Date | null | undefined): string {
  if (!date) return "—";
  return DateTime.fromJSDate(date, { zone: getAppTimezone() }).toISO() ?? "—";
}
