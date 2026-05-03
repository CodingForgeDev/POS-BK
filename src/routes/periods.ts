import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Period from "../models/Period";
import JournalEntry from "../models/JournalEntry";
import LedgerAccount from "../models/LedgerAccount";
import Setting from "../models/Setting";
import { createJournalEntryRecord } from "../lib/journalPosting";
import { logAuditTrail } from "../lib/auditLog";
import mongoose from "mongoose";

const router: Router = Router();

/**
 * GET /api/periods
 * List all accounting periods
 */
router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { status, year } = req.query as Record<string, string>;
    
    const query: any = {};
    if (status) {
      query.status = status;
    }
    if (year) {
      const yearNum = parseInt(year);
      query.startDate = {
        $gte: new Date(`${yearNum}-01-01`),
        $lte: new Date(`${yearNum}-12-31`),
      };
    }
    
    const periods = await Period.find(query)
      .populate("closedBy", "name")
      .populate("closingJournalEntryId")
      .sort({ startDate: -1 })
      .lean();
    
    return sendSuccess(res, periods);
  } catch (error) {
    console.error("Error fetching periods:", error);
    return sendError(res, "Failed to fetch periods", 500);
  }
});

/**
 * GET /api/periods/:id
 * Get single period details
 */
router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const period = await Period.findById(req.params.id)
      .populate("closedBy", "name")
      .populate("closingJournalEntryId");
    
    if (!period) {
      return sendError(res, "Period not found", 404);
    }
    
    return sendSuccess(res, period);
  } catch (error) {
    console.error("Error fetching period:", error);
    return sendError(res, "Failed to fetch period", 500);
  }
});

/**
 * POST /api/periods
 * Create a new accounting period
 */
router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { name, startDate, endDate, notes } = req.body;
    
    // Validation
    if (!name || !startDate || !endDate) {
      return sendError(res, "Name, start date, and end date are required", 400);
    }
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (end <= start) {
      return sendError(res, "End date must be after start date", 400);
    }
    
    // Check for overlapping periods
    const overlapping = await Period.findOne({
      $or: [
        { startDate: { $lte: end }, endDate: { $gte: start } },
      ],
    });
    
    if (overlapping) {
      return sendError(res, `Period overlaps with existing period: ${overlapping.name}`, 400);
    }
    
    const period = await Period.create({
      name,
      startDate: start,
      endDate: end,
      notes: notes || "",
      status: "open",
    });
    
    console.log(`✅ Created accounting period: ${name} (${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]})`);
    
    // Audit log
    await logAuditTrail({
      userId: req.user._id,
      action: "CREATE_PERIOD",
      module: "periods",
      description: `Created accounting period: ${name}`,
      metadata: { periodId: period._id, startDate, endDate },
    });
    
    return sendSuccess(res, period, "Period created successfully", 201);
  } catch (error: any) {
    console.error("Error creating period:", error);
    return sendError(res, error.message || "Failed to create period", 500);
  }
});

/**
 * PATCH /api/periods/:id
 * Update period details (cannot update if closed/locked)
 */
router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const period = await Period.findById(req.params.id);
    if (!period) {
      return sendError(res, "Period not found", 404);
    }
    
    if (period.status === "locked") {
      return sendError(res, "Cannot update a locked period", 400);
    }
    
    const { name, notes } = req.body;
    
    if (name) period.name = name;
    if (notes !== undefined) period.notes = notes;
    
    await period.save();
    
    return sendSuccess(res, period, "Period updated successfully");
  } catch (error) {
    console.error("Error updating period:", error);
    return sendError(res, "Failed to update period", 500);
  }
});

/**
 * POST /api/periods/:id/close
 * Close an accounting period (create closing entry)
 */
router.post("/:id/close", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const period = await Period.findById(req.params.id);
    if (!period) {
      return sendError(res, "Period not found", 404);
    }
    
    if (period.status !== "open") {
      return sendError(res, `Period is already ${period.status}`, 400);
    }
    
    // Get revenue, expense, and retained earnings accounts
    const revenueAccounts = await LedgerAccount.find({ type: "revenue", isActive: true });
    const expenseAccounts = await LedgerAccount.find({ type: "expense", isActive: true });
    
    // Get retained earnings account
    const retainedEarningsSetting = await Setting.findOne({ key: "defaultRetainedEarningsAccountId" });
    let retainedEarningsAccount = null;
    
    if (retainedEarningsSetting && retainedEarningsSetting.value) {
      retainedEarningsAccount = await LedgerAccount.findById(retainedEarningsSetting.value);
    }
    
    if (!retainedEarningsAccount) {
      retainedEarningsAccount = await LedgerAccount.findOne({
        type: "equity",
        subcategory: "retained-earnings",
      }).sort({ code: 1 });
    }
    
    if (!retainedEarningsAccount) {
      return sendError(res, "No retained earnings account found. Create one first.", 400);
    }
    
    // Calculate net profit from journal entries within period
    const entries = await JournalEntry.find({
      date: { $gte: period.startDate, $lte: period.endDate },
      status: "posted",
    }).lean();
    
    let totalRevenue = 0;
    let totalExpenses = 0;
    
    const accountTotals = new Map<string, { debit: number; credit: number }>();
    
    for (const entry of entries) {
      for (const line of entry.lines || []) {
        const accountId = String(line.account);
        const current = accountTotals.get(accountId) || { debit: 0, credit: 0 };
        current.debit += Number(line.debit || 0);
        current.credit += Number(line.credit || 0);
        accountTotals.set(accountId, current);
      }
    }
    
    // Calculate revenue (credits - debits)
    for (const account of revenueAccounts) {
      const totals = accountTotals.get(account._id.toString()) || { debit: 0, credit: 0 };
      totalRevenue += totals.credit - totals.debit;
    }
    
    // Calculate expenses (debits - credits)
    for (const account of expenseAccounts) {
      const totals = accountTotals.get(account._id.toString()) || { debit: 0, credit: 0 };
      totalExpenses += totals.debit - totals.credit;
    }
    
    const netProfit = totalRevenue - totalExpenses;
    
    // Create closing entry journal lines
    const closingLines: any[] = [];
    
    // Close revenue accounts (Debit Revenue, Credit Retained Earnings)
    for (const account of revenueAccounts) {
      const totals = accountTotals.get(account._id.toString()) || { debit: 0, credit: 0 };
      const balance = totals.credit - totals.debit;
      
      if (balance !== 0) {
        closingLines.push({
          account: account._id,
          accountName: account.title,
          debit: Math.abs(balance),
          credit: 0,
          note: `Close ${period.name} revenue to retained earnings`,
        });
      }
    }
    
    // Close expense accounts (Credit Expense, Debit Retained Earnings)
    for (const account of expenseAccounts) {
      const totals = accountTotals.get(account._id.toString()) || { debit: 0, credit: 0 };
      const balance = totals.debit - totals.credit;
      
      if (balance !== 0) {
        closingLines.push({
          account: account._id,
          accountName: account.title,
          debit: 0,
          credit: Math.abs(balance),
          note: `Close ${period.name} expenses to retained earnings`,
        });
      }
    }
    
    // Add retained earnings line (balancing entry)
    if (netProfit >= 0) {
      // Profit: Credit Retained Earnings
      closingLines.push({
        account: retainedEarningsAccount._id,
        accountName: retainedEarningsAccount.title,
        debit: 0,
        credit: Math.abs(netProfit),
        note: `Net profit for ${period.name}`,
      });
    } else {
      // Loss: Debit Retained Earnings
      closingLines.push({
        account: retainedEarningsAccount._id,
        accountName: retainedEarningsAccount.title,
        debit: Math.abs(netProfit),
        credit: 0,
        note: `Net loss for ${period.name}`,
      });
    }
    
    // Create the closing journal entry
    const closingEntry = await createJournalEntryRecord({
      date: period.endDate,
      reference: `CLOSE-${period.name.replace(/\s/g, "-")}`,
      description: `Closing entry for ${period.name} - Transfer ${netProfit >= 0 ? "profit" : "loss"} to retained earnings`,
      lines: closingLines,
      source: "CLOSING",
      sourceId: period._id,
      postedBy: req.user._id,
    });
    
    // Update period
    period.status = "closed";
    period.netProfit = netProfit;
    period.closingJournalEntryId = closingEntry._id as any;
    period.closedBy = req.user._id;
    period.closedAt = new Date();
    await period.save();
    
    console.log(`✅ Closed period: ${period.name} | Net ${netProfit >= 0 ? "Profit" : "Loss"}: Rs ${Math.abs(netProfit).toFixed(2)}`);
    
    // Audit log
    await logAuditTrail({
      userId: req.user._id,
      action: "CLOSE_PERIOD",
      module: "periods",
      description: `Closed period: ${period.name} with net ${netProfit >= 0 ? "profit" : "loss"} of Rs ${Math.abs(netProfit).toFixed(2)}`,
      metadata: { periodId: period._id, netProfit, totalRevenue, totalExpenses },
    });
    
    return sendSuccess(res, {
      period,
      closingEntry,
      netProfit,
      totalRevenue,
      totalExpenses,
    }, "Period closed successfully");
  } catch (error: any) {
    console.error("Error closing period:", error);
    return sendError(res, error.message || "Failed to close period", 500);
  }
});

/**
 * POST /api/periods/:id/reopen
 * Reopen a closed period (reverse closing entry)
 */
router.post("/:id/reopen", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const period = await Period.findById(req.params.id);
    if (!period) {
      return sendError(res, "Period not found", 404);
    }
    
    if (period.status === "locked") {
      return sendError(res, "Cannot reopen a locked period", 400);
    }
    
    if (period.status === "open") {
      return sendError(res, "Period is already open", 400);
    }
    
    // Delete the closing journal entry
    if (period.closingJournalEntryId) {
      await JournalEntry.findByIdAndDelete(period.closingJournalEntryId);
      console.log(`🔄 Deleted closing entry for period: ${period.name}`);
    }
    
    // Reopen the period
    period.status = "open";
    period.closingJournalEntryId = undefined;
    period.netProfit = 0;
    period.closedBy = undefined;
    period.closedAt = undefined;
    await period.save();
    
    console.log(`✅ Reopened period: ${period.name}`);
        // Audit log
    await logAuditTrail({
      userId: req.user._id,
      action: "REOPEN_PERIOD",
      module: "periods",
      description: `Reopened period: ${period.name}`,
      metadata: { periodId: period._id },
    });
        return sendSuccess(res, period, "Period reopened successfully");
  } catch (error) {
    console.error("Error reopening period:", error);
    return sendError(res, "Failed to reopen period", 500);
  }
});

/**
 * POST /api/periods/:id/lock
 * Lock a period permanently (cannot reopen after locking)
 */
router.post("/:id/lock", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const period = await Period.findById(req.params.id);
    if (!period) {
      return sendError(res, "Period not found", 404);
    }
    
    if (period.status !== "closed") {
      return sendError(res, "Period must be closed before locking", 400);
    }
    
    period.status = "locked";
    await period.save();
    
    console.log(`🔒 Locked period: ${period.name}`);
    
    // Audit log
    await logAuditTrail({
      userId: req.user._id,
      action: "LOCK_PERIOD",
      module: "periods",
      description: `Locked period: ${period.name} permanently`,
      metadata: { periodId: period._id },
    });
    
    return sendSuccess(res, period, "Period locked successfully");
  } catch (error) {
    console.error("Error locking period:", error);
    return sendError(res, "Failed to lock period", 500);
  }
});

/**
 * DELETE /api/periods/:id
 * Delete a period (only if open and no entries posted)
 */
router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const period = await Period.findById(req.params.id);
    if (!period) {
      return sendError(res, "Period not found", 404);
    }
    
    if (period.status !== "open") {
      return sendError(res, `Cannot delete a ${period.status} period`, 400);
    }
    
    // Check if any journal entries exist in this period
    const entriesCount = await JournalEntry.countDocuments({
      date: { $gte: period.startDate, $lte: period.endDate },
    });
    
    if (entriesCount > 0) {
      return sendError(res, `Cannot delete period with ${entriesCount} journal entries. Delete entries first.`, 400);
    }
    
    await period.deleteOne();
    
    console.log(`🗑️ Deleted period: ${period.name}`);
    
    return sendSuccess(res, null, "Period deleted successfully");
  } catch (error) {
    console.error("Error deleting period:", error);
    return sendError(res, "Failed to delete period", 500);
  }
});

export default router;
