import Employee from "../models/Employee";
import Attendance from "../models/Attendance";
import { computeHoursWorked, startOfLocalDay } from "./attendanceHelpers";

export type DevicePunchType = "in" | "out";

/** Shared shape for ADMS HTTP and ZK TCP pull sync. */
export interface DeviceAttendancePunch {
  deviceUserId: string;
  timestamp: Date;
  punchType: DevicePunchType | null;
  rawStatus1?: number | null;
}

type AttendanceClockFields = {
  clockIn: Date | null | undefined;
  clockOut: Date | null | undefined;
  hoursWorked?: number;
};

/** Maps device state (ADMS status1 / ZK verify-state byte) using the same env as ADMS. */
export function devicePunchTypeFromRawStatus1(status1: number | null): DevicePunchType | null {
  if (status1 === null) return null;
  const inValue = Number.parseInt(process.env.ZKTECO_CLOCK_IN_VALUE ?? "0", 10);
  const outValue = Number.parseInt(process.env.ZKTECO_CLOCK_OUT_VALUE ?? "1", 10);
  if (status1 === inValue) return "in";
  if (status1 === outValue) return "out";
  return null;
}

/**
 * Determine whether a device punch is clock-in or clock-out.
 *
 * Priority rule: existing record STATE always wins over device rawStatus.
 * Reason: ZKTeco devices frequently mark every scan as rawStatus=0 ("in")
 * regardless of actual direction (Auto mode, wrong button, firmware quirk).
 * The existing attendance row carries more reliable context.
 *
 * Decision tree:
 *   1. No existing record yet            → "in"
 *   2. clockIn set, clockOut missing     → "out"   (even if rawStatus says "in")
 *   3. Both clockIn + clockOut exist:
 *      a. timestamp ≤ clockIn            → "in"    (earlier scan, update clockIn)
 *      b. timestamp ≥ clockOut           → "out"   (later scan, update clockOut)
 *      c. timestamp between the two      → use rawStatus hint, else midpoint
 */
function resolveEffectivePunchType(
  punch: DeviceAttendancePunch,
  existing: AttendanceClockFields | null
): DevicePunchType {
  // Case 1 — no record for this day yet
  if (!existing || !existing.clockIn) return "in";

  // Case 2 — clocked in but not yet out → this must be clock-out
  if (!existing.clockOut) return "out";

  // Case 3 — both already set; use timestamp position to decide direction
  if (punch.timestamp.getTime() <= existing.clockIn.getTime()) return "in";
  if (punch.timestamp.getTime() >= existing.clockOut.getTime()) return "out";

  // Case 3c — timestamp strictly between clockIn and clockOut:
  // use rawStatus as a tiebreaker; fall back to midpoint.
  if (punch.punchType) return punch.punchType;
  const midMs =
    existing.clockIn.getTime() +
    (existing.clockOut.getTime() - existing.clockIn.getTime()) / 2;
  return punch.timestamp.getTime() < midMs ? "in" : "out";
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

/**
 * Upsert a single device punch into the per-day Attendance summary (earliest in, latest out).
 * Used by ADMS push and ZK TCP pull — keep behavior identical.
 */
export async function upsertDevicePunchToAttendance(
  punch: DeviceAttendancePunch
): Promise<{ saved: boolean; reason?: string }> {
  const employee = await Employee.findOne({
    $or: [{ deviceUserId: punch.deviceUserId }, { employeeId: punch.deviceUserId }],
  }).select("_id");
  if (!employee?._id) return { saved: false, reason: "employee_not_found" };

  const day = startOfLocalDay(punch.timestamp);

  const existing = await Attendance.findOne({ employee: employee._id, date: day });

  const effectiveType = resolveEffectivePunchType(punch, existing);

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
