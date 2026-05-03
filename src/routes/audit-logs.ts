import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import { getAuditLogs } from "../lib/auditLog";

const router: Router = Router();

/**
 * GET /api/audit-logs
 * Get audit trail logs with filters
 */
router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const {
      userId,
      module,
      action,
      dateFrom,
      dateTo,
      page = "1",
      limit = "50",
    } = req.query as Record<string, string>;
    
    const filters: any = {
      page: parseInt(page),
      limit: parseInt(limit),
    };
    
    if (userId) filters.userId = userId;
    if (module) filters.module = module;
    if (action) filters.action = action;
    if (dateFrom) filters.dateFrom = new Date(dateFrom);
    if (dateTo) filters.dateTo = new Date(dateTo);
    
    const { logs, total } = await getAuditLogs(filters);
    
    return sendSuccess(res, {
      logs,
      total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.ceil(total / filters.limit),
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    return sendError(res, "Failed to fetch audit logs", 500);
  }
});

/**
 * GET /api/audit-logs/modules
 * Get list of available modules for filtering
 */
router.get("/modules", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const modules = [
      "accounting",
      "payments",
      "periods",
      "orders",
      "billing",
      "inventory",
      "expenses",
      "menu",
      "employees",
      "customers",
      "settings",
      "auth",
    ];
    
    return sendSuccess(res, modules);
  } catch (error) {
    console.error("Error fetching modules:", error);
    return sendError(res, "Failed to fetch modules", 500);
  }
});

export default router;
