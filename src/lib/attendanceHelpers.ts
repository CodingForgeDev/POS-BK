import mongoose from "mongoose";
import { startOfBusinessDay, parseBusinessDay } from "./appTimezone";

export const ATTENDANCE_STATUSES = ["present", "absent", "late", "half-day", "leave"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/**
 * Returns midnight of the given Date in the business timezone (APP_TIMEZONE).
 * Used by device push / pull sync to determine which calendar day a punch belongs to.
 */
export function startOfLocalDay(d: Date): Date {
  return startOfBusinessDay(d);
}

/**
 * Parses a date value into the start-of-day in the business timezone (APP_TIMEZONE).
 * Used by the manual attendance API and query filters.
 */
export function parseAttendanceDay(dateInput: unknown): Date | null {
  return parseBusinessDay(dateInput);
}

export type ParseClockFieldResult = { kind: "omit" } | { kind: "invalid" } | { kind: "ok"; date: Date };

/** For manual API: distinguish omitted field vs invalid ISO string. */
export function parseClockFieldFromBody(v: unknown): ParseClockFieldResult {
  if (v === undefined || v === null || v === "") return { kind: "omit" };
  const d = new Date(v as string | Date);
  if (Number.isNaN(d.getTime())) return { kind: "invalid" };
  return { kind: "ok", date: d };
}

export function computeHoursWorked(clockIn: Date | null | undefined, clockOut: Date | null | undefined): number {
  if (!clockIn || !clockOut) return 0;
  const ms = clockOut.getTime() - clockIn.getTime();
  if (ms < 0) return 0;
  return ms / (1000 * 60 * 60);
}

export function isValidAttendanceStatus(s: unknown): s is AttendanceStatus {
  return typeof s === "string" && (ATTENDANCE_STATUSES as readonly string[]).includes(s);
}

export function isValidEmployeeObjectId(id: unknown): boolean {
  return typeof id === "string" && mongoose.Types.ObjectId.isValid(id);
}
