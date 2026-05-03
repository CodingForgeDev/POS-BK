import ActivityLog from "../models/ActivityLog";
import mongoose from "mongoose";

export interface AuditLogPayload {
  userId: mongoose.Types.ObjectId | string;
  action: string;
  module: "accounting" | "payments" | "periods" | "orders" | "billing" | "inventory" | "expenses";
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Log an audit trail entry for accounting and financial operations
 */
export async function logAuditTrail(payload: AuditLogPayload): Promise<void> {
  try {
    await ActivityLog.create({
      user: payload.userId,
      action: payload.action,
      module: payload.module,
      description: payload.description,
      metadata: payload.metadata || {},
      ipAddress: payload.ipAddress || "",
    });
  } catch (error) {
    console.error("Failed to log audit trail:", error);
    // Don't throw - audit logging should not break operations
  }
}

/**
 * Get audit logs with filters
 */
export async function getAuditLogs(filters: {
  userId?: string;
  module?: string;
  action?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}): Promise<{ logs: any[]; total: number }> {
  const query: any = {};
  
  if (filters.userId && mongoose.Types.ObjectId.isValid(filters.userId)) {
    query.user = filters.userId;
  }
  if (filters.module) {
    query.module = filters.module;
  }
  if (filters.action) {
    query.action = { $regex: filters.action, $options: "i" };
  }
  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) query.createdAt.$gte = filters.dateFrom;
    if (filters.dateTo) query.createdAt.$lte = filters.dateTo;
  }
  
  const page = filters.page || 1;
  const limit = filters.limit || 50;
  
  const [logs, total] = await Promise.all([
    ActivityLog.find(query)
      .populate("user", "name email role")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ActivityLog.countDocuments(query),
  ]);
  
  return { logs, total };
}
