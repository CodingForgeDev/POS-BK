import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    name: string;
    email: string;
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
    role: decoded.role,
    name: decoded.name,
    email: decoded.email,
  };

  next();
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
