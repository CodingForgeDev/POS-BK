import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Role from "../models/Role";
import { normalizeRoleType, isAdminOrManagerRoleName } from "../lib/role-utils";

const router: Router = Router();

type PermissionFlags = {
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
};

function normalizePermissions(raw: unknown): Record<string, PermissionFlags> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const permissions: Record<string, PermissionFlags> = {};

  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const value = (raw as Record<string, unknown>)[key];
    if (!value || typeof value !== "object") continue;

    permissions[key] = {
      create: Boolean((value as Record<string, unknown>).create),
      read: Boolean((value as Record<string, unknown>).read),
      update: Boolean((value as Record<string, unknown>).update),
      delete: Boolean((value as Record<string, unknown>).delete),
    };
  }

  return permissions;
}

function normalizeAllowedPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((path) => typeof path === "string" && path.trim());
}

function normalizeViewStaffLogins(raw: unknown): "all" | "own" | null {
  if (raw === "all") return "all";
  if (raw === "own") return "own";
  return null;
}

router.get("/", authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const roles = await Role.find().sort({ name: 1 }).lean();
    return sendSuccess(res, roles);
  } catch (error) {
    console.error("Get roles error:", error);
    return sendError(res, "Failed to fetch roles", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!(await isAdminOrManagerRoleName(req.user.role))) {
      return sendError(res, "Unauthorized", 403);
    }

    const { name, description, allowedPaths, permissions, viewStaffLogins, roleType } = req.body;
    if (typeof name !== "string" || !name.trim()) {
      return sendError(res, "Role name is required", 400);
    }

    const trimmedName = name.trim();
    const existing = await Role.findOne({ name: trimmedName });
    if (existing) {
      return sendError(res, "Role name already exists", 409);
    }

    const normalizedRoleType = normalizeRoleType(roleType);
    if (roleType !== undefined && normalizedRoleType === null) {
      return sendError(res, "Invalid roleType", 400);
    }

    const normalizedViewStaffLogins = normalizeViewStaffLogins(viewStaffLogins);
    if (viewStaffLogins !== undefined && normalizedViewStaffLogins === null) {
      return sendError(res, "Invalid viewStaffLogins", 400);
    }

    const role = await Role.create({
      name: trimmedName,
      description: typeof description === "string" ? description.trim() : "",
      allowedPaths: normalizeAllowedPaths(allowedPaths),
      roleType: normalizedRoleType ?? "staff",
      viewStaffLogins: normalizedViewStaffLogins ?? "own",
      permissions: normalizePermissions(permissions),
      createdBy: req.user.id,
    });

    return sendSuccess(res, role, "Role created successfully", 201);
  } catch (error) {
    console.error("Create role error:", error);
    return sendError(res, "Failed to create role", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!(await isAdminOrManagerRoleName(req.user.role))) {
      return sendError(res, "Unauthorized", 403);
    }

    const { id } = req.params;
    if (!id) return sendError(res, "Invalid role id", 400);

    const existing = await Role.findById(id);
    if (!existing) return sendError(res, "Role not found", 404);

    const { name, description, allowedPaths, permissions, isDefault, viewStaffLogins, roleType } = req.body;
    const patch: Record<string, unknown> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) return sendError(res, "Role name is required", 400);
      const trimmedName = name.trim();
      if (trimmedName !== existing.name) {
        const duplicate = await Role.findOne({ name: trimmedName, _id: { $ne: existing._id } });
        if (duplicate) return sendError(res, "Role name already exists", 409);
      }
      patch.name = trimmedName;
    }

    if (description !== undefined) {
      if (typeof description !== "string") return sendError(res, "Invalid description", 400);
      patch.description = description.trim();
    }

    if (allowedPaths !== undefined) {
      patch.allowedPaths = normalizeAllowedPaths(allowedPaths);
    }

    if (permissions !== undefined) {
      patch.permissions = normalizePermissions(permissions);
    }

    if (viewStaffLogins !== undefined) {
      const normalizedViewStaffLogins = normalizeViewStaffLogins(viewStaffLogins);
      if (normalizedViewStaffLogins === null) return sendError(res, "Invalid viewStaffLogins", 400);
      patch.viewStaffLogins = normalizedViewStaffLogins;
    }

    if (roleType !== undefined) {
      const normalizedRoleType = normalizeRoleType(roleType);
      if (normalizedRoleType === null) return sendError(res, "Invalid roleType", 400);
      patch.roleType = normalizedRoleType;
    }

    if (isDefault !== undefined) {
      patch.isDefault = Boolean(isDefault);
    }

    if (Object.keys(patch).length === 0) {
      return sendError(res, "No updates provided", 400);
    }

    Object.assign(existing, patch);
    await existing.save();

    return sendSuccess(res, existing, "Role updated successfully");
  } catch (error) {
    console.error("Update role error:", error);
    return sendError(res, "Failed to update role", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!(await isAdminOrManagerRoleName(req.user.role))) {
      return sendError(res, "Unauthorized", 403);
    }

    const { id } = req.params;
    if (!id) return sendError(res, "Invalid role id", 400);

    const deleted = await Role.findByIdAndDelete(id);
    if (!deleted) return sendError(res, "Role not found", 404);

    return sendSuccess(res, null, "Role removed successfully");
  } catch (error) {
    console.error("Delete role error:", error);
    return sendError(res, "Failed to delete role", 500);
  }
});

export default router;
