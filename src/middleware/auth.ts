import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import Role from "../models/Role";
import { connectDB } from "../lib/mongodb";
import { hasRoleBilling } from "../lib/role-utils";

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    _id: string;
    role: string;
    name: string;
    email: string;
    hasBilling?: boolean;
  };
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const headerToken =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const cookieToken = (req as any).cookies?.pos_token || null;
  const token = headerToken || cookieToken;

  if (!token) {
    res
      .status(401)
      .json({ success: false, message: "Unauthorized: No token provided" });
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    res
      .status(401)
      .json({ success: false, message: "Unauthorized: Invalid or expired token" });
    return;
  }

  (req as AuthenticatedRequest).user = {
    id: decoded.id,
    _id: decoded.id,
    role: decoded.role,
    name: decoded.name,
    email: decoded.email,
  };

  // Populate hasBilling from role
  (async () => {
    try {
      await connectDB();
      const roleDoc = await Role.findOne({ name: decoded.role }).lean<any>();
      if (roleDoc && typeof roleDoc.hasBilling === "boolean") {
        (req as AuthenticatedRequest).user.hasBilling = roleDoc.hasBilling;
      } else {
        // Fallback: cashier, admin, manager get hasBilling=true
        const normalized = String(decoded.role).trim().toLowerCase();
        (req as AuthenticatedRequest).user.hasBilling = ["cashier", "admin", "manager"].includes(normalized);
      }
    } catch (err) {
      console.error("Failed to populate hasBilling:", err);
      // Fallback to safe default
      (req as AuthenticatedRequest).user.hasBilling = false;
    }
    next();
  })();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ success: false, message: "Forbidden: Insufficient permissions" });
      return;
    }
    next();
  };
}

export async function requireBilling(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = (req as AuthenticatedRequest).user;
  if (!user || !(await hasRoleBilling(user.role))) {
    res.status(403).json({ success: false, message: "Billing permission required", error: "Billing permission required" });
    return;
  }
  next();
}
