import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Attendance from "../models/Attendance";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { employee, date, month, year } = req.query as Record<string, string>;

    const query: any = {};
    if (employee) query.employee = employee;

    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    } else if (month && year) {
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999);
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

    const today = new Date(date);
    today.setHours(0, 0, 0, 0);

    let hoursWorked = 0;
    if (clockIn && clockOut) {
      hoursWorked =
        (new Date(clockOut).getTime() - new Date(clockIn).getTime()) /
        (1000 * 60 * 60);
    }

    const record = await Attendance.findOneAndUpdate(
      { employee: employeeId, date: today },
      {
        clockIn,
        clockOut,
        status: status || "present",
        notes: notes || "",
        hoursWorked,
      },
      { upsert: true, new: true }
    ).populate({ path: "employee", populate: { path: "user", select: "name" } });

    return sendSuccess(res, record, "Attendance recorded", 201);
  } catch (error) {
    return sendError(res, "Failed to record attendance", 500);
  }
});

export default router;
