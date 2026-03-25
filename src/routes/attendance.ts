import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Attendance from "../models/Attendance";
import {
  computeHoursWorked,
  isValidAttendanceStatus,
  isValidEmployeeObjectId,
  parseAttendanceDay,
  parseClockFieldFromBody,
} from "../lib/attendanceHelpers";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { employee, date, month, year } = req.query as Record<string, string>;

    const query: Record<string, unknown> = {};
    if (employee) {
      if (!isValidEmployeeObjectId(employee)) {
        return sendError(res, "Invalid employee id", 400);
      }
      query.employee = employee;
    }

    if (date) {
      const start = parseAttendanceDay(date);
      if (!start) return sendError(res, "Invalid date", 400);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    } else if (month && year) {
      const m = Number.parseInt(month, 10);
      const y = Number.parseInt(year, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12 || !Number.isFinite(y) || y < 1970 || y > 2100) {
        return sendError(res, "Invalid month or year", 400);
      }
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0, 23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }

    const records = await Attendance.find(query)
      .populate({ path: "employee", populate: { path: "user", select: "name" } })
      .sort({ date: -1 })
      .lean();

    return sendSuccess(res, records);
  } catch (error) {
    return sendError(res, "Failed to fetch attendance", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { employeeId, date, clockIn, clockOut, status, notes } = req.body;

    if (!isValidEmployeeObjectId(employeeId)) {
      return sendError(res, "Valid employeeId is required", 400);
    }

    const day = parseAttendanceDay(date);
    if (!day) {
      return sendError(res, "Valid date is required", 400);
    }

    const inRes = parseClockFieldFromBody(clockIn);
    const outRes = parseClockFieldFromBody(clockOut);
    if (inRes.kind === "invalid") return sendError(res, "Invalid clockIn", 400);
    if (outRes.kind === "invalid") return sendError(res, "Invalid clockOut", 400);

    const resolvedStatus = isValidAttendanceStatus(status) ? status : "present";
    const notesStr = typeof notes === "string" ? notes : "";

    const existing = await Attendance.findOne({ employee: employeeId, date: day });

    const mergedIn = inRes.kind === "ok" ? inRes.date : existing?.clockIn ?? undefined;
    const mergedOut = outRes.kind === "ok" ? outRes.date : existing?.clockOut ?? undefined;

    if (outRes.kind === "ok" && mergedIn === undefined) {
      return sendError(res, "Clock in is required before clock out", 400);
    }

    if (mergedIn !== undefined && mergedOut !== undefined && mergedOut.getTime() < mergedIn.getTime()) {
      return sendError(res, "clockOut cannot be earlier than clockIn", 400);
    }

    const $set: Record<string, unknown> = {
      status: resolvedStatus,
      notes: notesStr,
      hoursWorked: computeHoursWorked(mergedIn ?? null, mergedOut ?? null),
    };
    if (inRes.kind === "ok") $set.clockIn = inRes.date;
    if (outRes.kind === "ok") $set.clockOut = outRes.date;

    const record = await Attendance.findOneAndUpdate(
      { employee: employeeId, date: day },
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate({ path: "employee", populate: { path: "user", select: "name" } });

    return sendSuccess(res, record, "Attendance recorded", 201);
  } catch (error) {
    return sendError(res, "Failed to record attendance", 500);
  }
});

export default router;
