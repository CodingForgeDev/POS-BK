import Role from "../models/Role";

type RoleLean = { roleType?: "admin" | "manager" | "staff" };

export function normalizeRoleType(raw: unknown): "admin" | "manager" | "staff" | null {
  if (raw === "admin") return "admin";
  if (raw === "manager") return "manager";
  if (raw === "staff") return "staff";
  return null;
}

export async function isAdminRoleName(roleName: string): Promise<boolean> {
  if (roleName === "admin") return true;
  const role = await Role.findOne({ name: roleName }).lean<RoleLean>();
  return role?.roleType === "admin";
}

export async function isAdminOrManagerRoleName(roleName: string): Promise<boolean> {
  if (roleName === "admin" || roleName === "manager") return true;
  const role = await Role.findOne({ name: roleName }).lean<RoleLean>();
  return role?.roleType === "admin" || role?.roleType === "manager";
}

export async function getRoleTypeByName(roleName: string): Promise<"admin" | "manager" | "staff" | null> {
  if (roleName === "admin") return "admin";
  const role = await Role.findOne({ name: roleName }).lean<RoleLean>();
  return role?.roleType || null;
}
