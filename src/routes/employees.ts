import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Employee from "../models/Employee";
import User from "../models/User";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const employees = await Employee.find({ isActive: true })
      .populate("user", "name email phone role avatar")
      .sort({ createdAt: -1 })
      .lean();
    return sendSuccess(res, employees);
  } catch (error) {
    return sendError(res, "Failed to fetch employees", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);

    const { name, email, password, role, position, department, salary, salaryType, startDate, phone } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return sendError(res, "Email already registered", 409);

    const employeeCount = await Employee.countDocuments();
    const employeeId = `EMP-${String(employeeCount + 1).padStart(4, "0")}`;

    const user = await User.create({ name, email, password, role: role || "cashier", phone });

    const employee = await Employee.create({
      user: user._id,
      employeeId,
      position,
      department,
      salary: salary || 0,
      salaryType: salaryType || "hourly",
      startDate: new Date(startDate),
    });

    const populated = await employee.populate("user", "name email phone role");
    return sendSuccess(res, populated, "Employee created successfully", 201);
  } catch (error) {
    console.error("Create employee error:", error);
    return sendError(res, "Failed to create employee", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const employee = await Employee.findById(req.params.id).populate("user", "name email phone role avatar");
    if (!employee) return sendError(res, "Employee not found", 404);
    return sendSuccess(res, employee);
  } catch (error) {
    return sendError(res, "Failed to fetch employee", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    const employee = await Employee.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate(
      "user",
      "name email phone role"
    );
    if (!employee) return sendError(res, "Employee not found", 404);
    return sendSuccess(res, employee, "Employee updated successfully");
  } catch (error) {
    return sendError(res, "Failed to update employee", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    const employee = await Employee.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!employee) return sendError(res, "Employee not found", 404);
    return sendSuccess(res, null, "Employee deactivated successfully");
  } catch (error) {
    return sendError(res, "Failed to deactivate employee", 500);
  }
});

export default router;
