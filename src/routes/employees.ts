import mongoose from "mongoose";
import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Employee from "../models/Employee";
import User from "../models/User";

const router: Router = Router();

const SALARY_TYPES = ["hourly", "weekly", "monthly"] as const;
const USER_ROLES = ["admin", "cashier", "kitchen", "manager"] as const;

function isPatchBuildError(r: unknown): r is { error: string } {
  return (
    typeof r === "object" &&
    r !== null &&
    "error" in r &&
    typeof (r as { error: unknown }).error === "string"
  );
}

function pickEmergencyContact(raw: Record<string, unknown>): Record<string, string> | null {
  const next: Record<string, string> = {};
  for (const k of ["name", "phone", "relationship"] as const) {
    if (typeof raw[k] === "string") next[k] = raw[k].trim();
  }
  return Object.keys(next).length ? next : null;
}

function buildEmployeeUpdatePayload(
  body: Record<string, unknown>,
  allowIsActive: boolean
): Record<string, unknown> | { error: string } {
  const patch: Record<string, unknown> = {};

  if (body.position !== undefined) {
    if (typeof body.position !== "string" || !body.position.trim()) return { error: "Invalid position" };
    patch.position = body.position.trim();
  }
  if (body.department !== undefined) {
    if (typeof body.department !== "string" || !body.department.trim()) return { error: "Invalid department" };
    patch.department = body.department.trim();
  }
  if (body.salary !== undefined) {
    const n = Number(body.salary);
    if (!Number.isFinite(n) || n < 0) return { error: "Invalid salary" };
    patch.salary = n;
  }
  if (body.salaryType !== undefined) {
    if (!SALARY_TYPES.includes(body.salaryType as (typeof SALARY_TYPES)[number])) return { error: "Invalid salary type" };
    patch.salaryType = body.salaryType;
  }
  if (body.startDate !== undefined) {
    const d = new Date(body.startDate as string);
    if (Number.isNaN(d.getTime())) return { error: "Invalid start date" };
    patch.startDate = d;
  }
  if (body.endDate !== undefined) {
    if (body.endDate === null || body.endDate === "") {
      patch.endDate = null;
    } else {
      const d = new Date(body.endDate as string);
      if (Number.isNaN(d.getTime())) return { error: "Invalid end date" };
      patch.endDate = d;
    }
  }
  if (body.address !== undefined) {
    patch.address = typeof body.address === "string" ? body.address.trim() : "";
  }
  if (body.taxFileNumber !== undefined) {
    patch.taxFileNumber = typeof body.taxFileNumber === "string" ? body.taxFileNumber.trim() : "";
  }
  if (body.bankAccount !== undefined) {
    patch.bankAccount = typeof body.bankAccount === "string" ? body.bankAccount.trim() : "";
  }
  if (body.notes !== undefined) {
    patch.notes = typeof body.notes === "string" ? body.notes.trim() : "";
  }
  if (body.deviceUserId !== undefined) {
    if (body.deviceUserId === null) {
      patch.deviceUserId = null;
    } else if (typeof body.deviceUserId === "string") {
      const t = body.deviceUserId.trim();
      patch.deviceUserId = t.length ? t : null;
    } else {
      return { error: "Invalid deviceUserId" };
    }
  }
  if (allowIsActive && body.isActive !== undefined) {
    patch.isActive = Boolean(body.isActive);
  }
  if (body.emergencyContact !== undefined) {
    if (body.emergencyContact !== null && typeof body.emergencyContact === "object") {
      const em = pickEmergencyContact(body.emergencyContact as Record<string, unknown>);
      if (em) patch.emergencyContact = em;
    } else if (body.emergencyContact === null) {
      patch.emergencyContact = { name: "", phone: "", relationship: "" };
    }
  }

  return patch;
}

/** User account fields live on `User`, not `Employee`. Only admins may change these via PATCH. */
function buildUserUpdatePayload(body: Record<string, unknown>): Record<string, unknown> | { error: string } {
  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return { error: "Invalid name" };
    patch.name = body.name.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== "string" || !body.email.trim()) return { error: "Invalid email" };
    patch.email = body.email.trim().toLowerCase();
  }
  if (body.phone !== undefined) {
    patch.phone = typeof body.phone === "string" ? body.phone.trim() : "";
  }
  if (body.role !== undefined) {
    if (typeof body.role !== "string" || !USER_ROLES.includes(body.role as (typeof USER_ROLES)[number])) {
      return { error: "Invalid role" };
    }
    patch.role = body.role;
  }
  if (body.password !== undefined) {
    if (typeof body.password !== "string") return { error: "Invalid password" };
    patch.password = body.password;
  }

  return patch;
}

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

    const { name, email, password, role, position, department, salary, salaryType, startDate, phone, deviceUserId } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return sendError(res, "Email already registered", 409);

    const employeeCount = await Employee.countDocuments();
    const employeeId = `EMP-${String(employeeCount + 1).padStart(4, "0")}`;

    const user = await User.create({ name, email, password, role: role || "cashier", phone });

    const employee = await Employee.create({
      user: user._id,
      employeeId,
      deviceUserId: deviceUserId ?? employeeId,
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendError(res, "Invalid employee id", 400);
    }
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendError(res, "Invalid employee id", 400);
    }

    const employee = await Employee.findById(req.params.id);
    if (!employee) return sendError(res, "Employee not found", 404);

    const body = req.body as Record<string, unknown>;
    const allowIsActive = req.user.role === "admin";

    const employeePatchOrErr = buildEmployeeUpdatePayload(body, allowIsActive);
    if (isPatchBuildError(employeePatchOrErr)) {
      return sendError(res, employeePatchOrErr.error, 400);
    }
    const employeePatch = employeePatchOrErr;

    let userPatch: Record<string, unknown> = {};
    if (req.user.role === "admin") {
      const userPatchOrErr = buildUserUpdatePayload(body);
      if (isPatchBuildError(userPatchOrErr)) {
        return sendError(res, userPatchOrErr.error, 400);
      }
      userPatch = userPatchOrErr;
    }

    if (Object.keys(employeePatch).length === 0 && Object.keys(userPatch).length === 0) {
      return sendError(res, "No updatable fields provided", 400);
    }

    if (Object.keys(userPatch).length > 0) {
      const user = await User.findById(employee.user);
      if (!user) return sendError(res, "Linked user not found", 404);

      if (userPatch.email && userPatch.email !== user.email) {
        const taken = await User.findOne({ email: userPatch.email as string, _id: { $ne: user._id } });
        if (taken) return sendError(res, "Email already in use", 409);
      }

      if (typeof userPatch.name === "string") user.name = userPatch.name;
      if (typeof userPatch.email === "string") user.email = userPatch.email;
      if (typeof userPatch.phone === "string") user.phone = userPatch.phone;
      if (typeof userPatch.role === "string") user.role = userPatch.role;

      if (typeof userPatch.password === "string" && userPatch.password.length > 0) {
        if (userPatch.password.length < 6) {
          return sendError(res, "Password must be at least 6 characters", 400);
        }
        user.password = userPatch.password;
      }

      await user.save();
    }

    if (Object.keys(employeePatch).length > 0) {
      Object.assign(employee, employeePatch);
      await employee.save();
    }

    const populated = await Employee.findById(employee._id).populate("user", "name email phone role avatar");
    return sendSuccess(res, populated, "Employee updated successfully");
  } catch (error) {
    console.error("Update employee error:", error);
    return sendError(res, "Failed to update employee", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendError(res, "Invalid employee id", 400);
    }
    const employee = await Employee.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!employee) return sendError(res, "Employee not found", 404);
    return sendSuccess(res, null, "Employee deactivated successfully");
  } catch (error) {
    return sendError(res, "Failed to deactivate employee", 500);
  }
});

export default router;
