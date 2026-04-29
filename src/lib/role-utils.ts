import Role from "../models/Role";

type RoleLean = { roleType?: "admin" | "manager" | "staff" };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRoleName(roleName: unknown): string {
  return typeof roleName === "string" ? roleName.trim().toLowerCase() : "";
}

export function normalizeRoleType(raw: unknown): "admin" | "manager" | "staff" | null {
  if (raw === "admin") return "admin";
  if (raw === "manager") return "manager";
  if (raw === "staff") return "staff";
  return null;
}

export async function isAdminRoleName(roleName: string): Promise<boolean> {
  const normalized = normalizeRoleName(roleName);
  if (normalized === "admin") return true;
  const role = await Role.findOne({ name: new RegExp(`^${escapeRegExp(roleName)}$`, "i") }).lean<RoleLean>();
  return role?.roleType === "admin";
}

export async function isAdminOrManagerRoleName(roleName: string): Promise<boolean> {
  const normalized = normalizeRoleName(roleName);
  if (normalized === "admin" || normalized === "manager") return true;
  const role = await Role.findOne({ name: new RegExp(`^${escapeRegExp(roleName)}$`, "i") }).lean<RoleLean>();
  return role?.roleType === "admin" || role?.roleType === "manager";
}

export async function getRoleTypeByName(roleName: string): Promise<"admin" | "manager" | "staff" | null> {
  const normalized = normalizeRoleName(roleName);
  if (normalized === "admin") return "admin";
  if (normalized === "manager") return "manager";
  const role = await Role.findOne({ name: new RegExp(`^${escapeRegExp(roleName)}$`, "i") }).lean<RoleLean>();
  return role?.roleType || null;
}
