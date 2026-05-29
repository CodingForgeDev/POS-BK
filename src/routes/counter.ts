import mongoose from "mongoose";
import { Router, Response } from "express";
import { connectDB } from "../lib/mongodb";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { sendSuccess, sendError } from "../lib/utils";
import CounterSession from "../models/CounterSession";
import Disbursement from "../models/Disbursement";
import {
  denomRecordToArray,
  postCounterCloseDeposit,
  postCounterDisbursement,
  repairCounterCloseJournal,
} from "../lib/counterPosting";

const router: Router = Router();

const roundMoney = (v: unknown) => Number(Number(v || 0).toFixed(2));
const roleCanDisburse = (role: unknown) =>
  ["admin", "manager"].includes(String(role || "").trim().toLowerCase());
const roleCanViewAllCounters = (role: unknown) =>
  ["admin", "manager"].includes(String(role || "").trim().toLowerCase());

const currentUserId = (req: AuthenticatedRequest) => String(req.user?.id || "");

const toOwnerId = (userId: string) =>
  mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;

const ownedOpenQuery = (userId: string) => ({
  status: "open" as const,
  openedBy: toOwnerId(userId),
});

const ownedClosedQuery = (userId: string) => ({
  status: "closed" as const,
  openedBy: toOwnerId(userId),
});

type DisbursementRow = {
  amount: number;
  remarks: string;
  authorizedBy: string;
  timestamp: Date;
  runningCashAfter: number;
  journalEntryId?: unknown;
};

async function loadSessionDisbursements(sessionId: unknown): Promise<{
  disbursements: DisbursementRow[];
  totalDisbursed: number;
}> {
  if (!sessionId) return { disbursements: [], totalDisbursed: 0 };

  const rows = await Disbursement.find({ sessionId })
    .sort({ timestamp: 1 })
    .lean();

  const disbursements: DisbursementRow[] = rows.map((row) => ({
    amount: roundMoney(row.amount),
    remarks: String(row.remarks || ""),
    authorizedBy: String(row.authorizedBy || ""),
    timestamp: row.timestamp ? new Date(row.timestamp) : new Date(),
    runningCashAfter: roundMoney(row.runningCashAfter),
    journalEntryId: row.journalEntryId || null,
  }));

  const totalDisbursed = roundMoney(
    disbursements.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );

  return { disbursements, totalDisbursed };
}

async function hydrateOpenSession(session: Record<string, unknown> | null) {
  if (!session?._id) return null;

  const embedded = Array.isArray(session.disbursements) ? session.disbursements : [];
  let disbursements = embedded as DisbursementRow[];
  let totalDisbursed = roundMoney(session.totalDisbursed);

  const fromDb = await loadSessionDisbursements(session._id);
  if (fromDb.totalDisbursed > totalDisbursed) {
    disbursements = fromDb.disbursements;
    totalDisbursed = fromDb.totalDisbursed;
    await CounterSession.updateOne(
      { _id: session._id },
      { $set: { disbursements, totalDisbursed } }
    );
  }

  return {
    ...session,
    disbursements,
    totalDisbursed,
  };
}

router.get("/status", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const userId = currentUserId(req);

    const openSessionRaw = await CounterSession.findOne(ownedOpenQuery(userId))
      .sort({ openedAt: -1 })
      .lean();

    const openSession = await hydrateOpenSession(openSessionRaw as Record<string, unknown> | null);

    const lastClosed = await CounterSession.findOne(ownedClosedQuery(userId))
      .sort({ closedAt: -1 })
      .lean();

    let otherOpenSessions: Array<Record<string, unknown>> = [];
    if (roleCanViewAllCounters(req.user?.role)) {
      const others = await CounterSession.find({
        status: "open",
        openedBy: { $ne: userId },
      })
        .sort({ openedAt: -1 })
        .lean();
      otherOpenSessions = others.map((s) => ({
        _id: s._id,
        openedAt: s.openedAt,
        cashierName: s.cashierName || "",
        openedBy: s.openedBy,
      }));
    }

    return sendSuccess(res, {
      openSession: openSession || null,
      lastClosed: lastClosed || null,
      pendingOpeningBalance: lastClosed
        ? {
            total: Number(lastClosed.openingBalance || 0),
            denominations: lastClosed.openingDenominations || [],
            remarks: lastClosed.remarks || "",
            setAt: lastClosed.closedAt,
          }
        : null,
      otherOpenSessions,
    });
  } catch (error) {
    console.error("Counter status error:", error);
    return sendError(res, "Failed to load counter status", 500);
  }
});

/** Closed counter sessions for Old Revenue Book (per-user; admin/manager sees all). */
router.get("/history", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const userId = currentUserId(req);
    const canViewAll = roleCanViewAllCounters(req.user?.role);
    const { dateFrom, dateTo, cashier, repairJournals } = req.query as Record<string, string>;

    const query: Record<string, unknown> = { status: "closed" };
    if (!canViewAll) {
      query.openedBy = userId;
    } else if (cashier && String(cashier).trim()) {
      query.cashierName = String(cashier).trim();
    }

    const closedAtQuery: Record<string, Date> = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      if (!Number.isNaN(from.getTime())) closedAtQuery.$gte = from;
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      if (!Number.isNaN(to.getTime())) closedAtQuery.$lte = to;
    }
    if (Object.keys(closedAtQuery).length) {
      query.closedAt = closedAtQuery;
    }

    let sessions = await CounterSession.find(query)
      .sort({ closedAt: -1 })
      .limit(300)
      .lean();

    let journalsRepaired = 0;
    if (repairJournals === "1" || repairJournals === "true") {
      const repairQuery: Record<string, unknown> = {
        status: "closed",
        closeJournalEntryId: null,
        $or: [{ depositedAmount: { $gt: 0 } }, { netDeposit: { $gt: 0 } }],
      };
      if (!canViewAll) {
        repairQuery.openedBy = userId;
      }

      const repairCandidates = await CounterSession.find(repairQuery)
        .sort({ closedAt: 1 })
        .limit(500)
        .lean();

      for (const session of repairCandidates) {
        const deposited = roundMoney(session.depositedAmount ?? session.netDeposit ?? 0);
        if (deposited <= 0) continue;
        try {
          const { journal, repaired } = await repairCounterCloseJournal(
            session as Record<string, unknown>
          );
          if (repaired && journal?._id) {
            await CounterSession.updateOne(
              { _id: session._id },
              { $set: { closeJournalEntryId: journal._id } }
            );
            journalsRepaired += 1;
          } else if (journal?._id && !session.closeJournalEntryId) {
            await CounterSession.updateOne(
              { _id: session._id },
              { $set: { closeJournalEntryId: journal._id } }
            );
          }
        } catch (repairError) {
          console.error("Counter close journal repair failed:", session._id, repairError);
        }
      }

      if (journalsRepaired > 0) {
        sessions = await CounterSession.find(query)
          .sort({ closedAt: -1 })
          .limit(300)
          .lean();
      }
    }

    let cashiers: string[] = [];
    if (canViewAll) {
      const fromSessions = await CounterSession.distinct("cashierName", {
        status: "closed",
        cashierName: { $ne: "" },
      });
      const fromOpen = await CounterSession.distinct("cashierName", {
        status: "open",
        cashierName: { $ne: "" },
      });
      cashiers = [...fromSessions, ...fromOpen]
        .map((name) => String(name || "").trim())
        .filter(Boolean);
      cashiers = [...new Set(cashiers)].sort();
    }

    return sendSuccess(res, {
      sessions,
      cashiers,
      journalsRepaired,
    });
  } catch (error) {
    console.error("Counter history error:", error);
    return sendError(res, "Failed to load counter history", 500);
  }
});

router.post("/close", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();

    const {
      sessionId,
      cashSales = 0,
      cardSales = 0,
      bankTransferSales = 0,
      countedCash,
      countedTotal: countedRaw,
      countedDenominations,
      openingBalance: sessionOpeningRaw,
      tomorrowOpening,
      netDeposit,
      difference,
      disbursements = [],
      openingBalance: openingRaw,
      openingDenominations,
      remarks = "",
      counterOpenedAt,
      closedAt,
      expectedCashInHand = 0,
      cashierName = "",
    } = req.body || {};

    const countedTotal = roundMoney(countedCash ?? countedRaw);
    const sessionOpeningBalance = roundMoney(sessionOpeningRaw ?? 0);
    const tomorrowOpeningBalance = roundMoney(tomorrowOpening ?? openingRaw ?? 0);

    if (countedTotal <= 0) {
      return sendError(res, "Counted cash total must be greater than zero", 400);
    }
    if (tomorrowOpeningBalance < 0) {
      return sendError(res, "Opening balance cannot be negative", 400);
    }
    if (tomorrowOpeningBalance > countedTotal) {
      return sendError(
        res,
        "Opening balance cannot exceed counted cash. Reduce opening float or increase counted total.",
        400
      );
    }

    const depositedAmount = roundMoney(
      netDeposit ?? (countedTotal - tomorrowOpeningBalance)
    );
    const openedAt = counterOpenedAt ? new Date(counterOpenedAt) : new Date();
    const closedAtDate = closedAt ? new Date(closedAt) : new Date();

    if (Number.isNaN(openedAt.getTime()) || Number.isNaN(closedAtDate.getTime())) {
      return sendError(res, "Invalid counter session timestamps", 400);
    }

    const userId = currentUserId(req);
    let session = sessionId
      ? await CounterSession.findOne({ _id: sessionId, status: "open", openedBy: userId })
      : await CounterSession.findOne(ownedOpenQuery(userId)).sort({ openedAt: -1 });

    if (!session) {
      if (sessionId) {
        const alreadyClosed = await CounterSession.findOne({
          _id: sessionId,
          status: "closed",
          openedBy: toOwnerId(userId),
        });
        if (alreadyClosed) {
          return sendSuccess(
            res,
            {
              session: alreadyClosed.toObject(),
              countedTotal: alreadyClosed.countedTotal,
              openingBalance: alreadyClosed.openingBalance,
              depositedAmount: alreadyClosed.depositedAmount,
              tomorrowOpening: alreadyClosed.tomorrowOpening,
              netDeposit: alreadyClosed.netDeposit,
              difference: alreadyClosed.difference,
              cashSales: alreadyClosed.cashSales,
              cardSales: alreadyClosed.cardSales,
              bankTransferSales: alreadyClosed.bankTransferSales,
              disbursements: alreadyClosed.disbursements || [],
              remarks: alreadyClosed.remarks,
              journalEntryId: alreadyClosed.closeJournalEntryId || null,
              pendingOpeningBalance: {
                total: Number(alreadyClosed.openingBalance || 0),
                denominations: alreadyClosed.openingDenominations || [],
                remarks: alreadyClosed.remarks || "",
                setAt: alreadyClosed.closedAt,
              },
            },
            "Counter already closed",
            200
          );
        }
      }

      const lastClosed = await CounterSession.findOne(ownedClosedQuery(userId))
        .sort({ closedAt: -1 })
        .lean();
      if (lastClosed?.closedAt && !Number.isNaN(closedAtDate.getTime())) {
        const deltaMs = Math.abs(
          new Date(lastClosed.closedAt).getTime() - closedAtDate.getTime()
        );
        if (deltaMs < 2 * 60 * 1000) {
          return sendSuccess(
            res,
            {
              session: lastClosed,
              countedTotal: lastClosed.countedTotal,
              openingBalance: lastClosed.openingBalance,
              depositedAmount: lastClosed.depositedAmount,
              tomorrowOpening: lastClosed.tomorrowOpening,
              netDeposit: lastClosed.netDeposit,
              difference: lastClosed.difference,
              cashSales: lastClosed.cashSales,
              cardSales: lastClosed.cardSales,
              bankTransferSales: lastClosed.bankTransferSales,
              disbursements: lastClosed.disbursements || [],
              remarks: lastClosed.remarks,
              journalEntryId: lastClosed.closeJournalEntryId || null,
              pendingOpeningBalance: {
                total: Number(lastClosed.openingBalance || 0),
                denominations: lastClosed.openingDenominations || [],
                remarks: lastClosed.remarks || "",
                setAt: lastClosed.closedAt,
              },
            },
            "Counter already closed",
            200
          );
        }
      }

      return sendError(res, "No open counter session found for your account. Open your counter first.", 404);
    }

    session.status = "closed";
    session.closedAt = closedAtDate;
    session.closedBy = req.user?.id as any;
    session.cashierName = String(cashierName || session.cashierName || req.user?.name || "");
    session.cashSales = roundMoney(cashSales);
    session.cardSales = roundMoney(cardSales);
    session.bankTransferSales = roundMoney(bankTransferSales);
    session.totalSales = roundMoney(
      session.cashSales + session.cardSales + session.bankTransferSales
    );
    session.sessionOpeningBalance = sessionOpeningBalance;
    session.countedTotal = countedTotal;
    session.countedDenominations = denomRecordToArray(countedDenominations);
    session.openingBalance = tomorrowOpeningBalance;
    session.openingDenominations = denomRecordToArray(openingDenominations);
    session.depositedAmount = depositedAmount;
    session.tomorrowOpening = tomorrowOpeningBalance;
    session.netDeposit = depositedAmount;
    session.difference = roundMoney(
      difference ?? (countedTotal - roundMoney(expectedCashInHand))
    );
    session.disbursements = Array.isArray(disbursements) ? disbursements : session.disbursements;
    session.totalDisbursed = roundMoney(
      (session.disbursements || []).reduce(
        (sum: number, d: any) => sum + Number(d?.amount || 0),
        0
      )
    );
    session.remarks = String(remarks || "").trim().slice(0, 500);
    session.expectedCashInHand = roundMoney(expectedCashInHand);

    await session.save();

    let journalEntry = null;
    try {
      journalEntry = await postCounterCloseDeposit({
        countedTotal,
        openingBalance: tomorrowOpeningBalance,
        depositedAmount,
        remarks: session.remarks,
        closedAt: closedAtDate,
        counterOpenedAt: openedAt,
        postedBy: String(req.user?.id || ""),
        sessionId: String(session._id),
      });
      if (journalEntry?._id) {
        session.closeJournalEntryId = journalEntry._id;
        await session.save();
      }
    } catch (journalError: any) {
      console.error("Counter close journal posting failed:", journalError);
      return sendError(
        res,
        journalError?.message || "Counter closed in session but accounting journal failed",
        500
      );
    }

    return sendSuccess(
      res,
      {
        session: session.toObject(),
        countedTotal,
        openingBalance: tomorrowOpeningBalance,
        depositedAmount,
        tomorrowOpening: tomorrowOpeningBalance,
        netDeposit: depositedAmount,
        difference: session.difference,
        cashSales: session.cashSales,
        cardSales: session.cardSales,
        bankTransferSales: session.bankTransferSales,
        disbursements: session.disbursements || [],
        remarks: session.remarks,
        journalEntryId: journalEntry?._id || null,
        pendingOpeningBalance: {
          total: tomorrowOpeningBalance,
          denominations: session.openingDenominations,
          remarks: session.remarks,
          setAt: closedAtDate,
        },
      },
      "Counter closed",
      201
    );
  } catch (error: any) {
    console.error("Counter close error:", error);
    return sendError(res, error?.message || "Failed to close counter", 500);
  }
});

router.post("/open", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();

    const userId = currentUserId(req);
    const existingOpen = await CounterSession.findOne(ownedOpenQuery(userId));
    if (existingOpen) {
      return sendError(res, "Your counter session is already open", 409);
    }

    const { openedAt, cashierName = "" } = req.body || {};
    const openedAtDate = openedAt ? new Date(openedAt) : new Date();
    if (Number.isNaN(openedAtDate.getTime())) {
      return sendError(res, "Invalid open timestamp", 400);
    }

    const lastClosed = await CounterSession.findOne(ownedClosedQuery(userId))
      .sort({ closedAt: -1 })
      .lean();

    const session = await CounterSession.create({
      status: "open",
      openedAt: openedAtDate,
      openedBy: req.user?.id,
      cashierName: String(cashierName || req.user?.name || ""),
      sessionOpeningBalance: Number(lastClosed?.tomorrowOpening || lastClosed?.openingBalance || 0),
      openingBalance: Number(lastClosed?.openingBalance || 0),
      openingDenominations: lastClosed?.openingDenominations || [],
    });

    return sendSuccess(
      res,
      {
        session: session.toObject(),
        openingBalance: Number(lastClosed?.openingBalance || 0),
        openingDenominations: lastClosed?.openingDenominations || [],
      },
      "Counter opened",
      201
    );
  } catch (error: any) {
    console.error("Counter open error:", error);
    return sendError(res, error?.message || "Failed to open counter", 500);
  }
});

router.post("/disburse", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!roleCanDisburse(req.user?.role)) {
      return sendError(res, "Only manager/admin can request cash disbursement", 403);
    }

    const {
      sessionId,
      amount: amountRaw,
      remarks,
      counterOpenedAt,
      cashSales,
      cardSales,
      bankTransferSales,
    } = req.body || {};
    const amount = roundMoney(amountRaw);
    const cleanedRemarks = String(remarks || "").trim();
    if (amount <= 0) return sendError(res, "Amount must be greater than zero", 400);
    if (!cleanedRemarks) return sendError(res, "Remarks are required", 400);

    const userId = currentUserId(req);
    let session = sessionId
      ? await CounterSession.findOne({ _id: sessionId, status: "open", openedBy: userId })
      : await CounterSession.findOne(ownedOpenQuery(userId)).sort({ openedAt: -1 });

    if (!session && counterOpenedAt) {
      const openedAtDate = new Date(counterOpenedAt);
      if (!Number.isNaN(openedAtDate.getTime())) {
        const lastClosed = await CounterSession.findOne(ownedClosedQuery(userId))
          .sort({ closedAt: -1 })
          .lean();
        session = await CounterSession.create({
          status: "open",
          openedAt: openedAtDate,
          openedBy: userId,
          cashierName: String(req.user?.name || ""),
          sessionOpeningBalance: roundMoney(
            lastClosed?.tomorrowOpening || lastClosed?.openingBalance || 0
          ),
          openingBalance: roundMoney(lastClosed?.openingBalance || 0),
          openingDenominations: lastClosed?.openingDenominations || [],
        });
      }
    }

    if (!session) {
      return sendError(res, "No open counter session found for your account", 404);
    }

    if (cashSales !== undefined) session.cashSales = roundMoney(cashSales);
    if (cardSales !== undefined) session.cardSales = roundMoney(cardSales);
    if (bankTransferSales !== undefined) {
      session.bankTransferSales = roundMoney(bankTransferSales);
    }
    session.totalSales = roundMoney(
      Number(session.cashSales || 0) +
        Number(session.cardSales || 0) +
        Number(session.bankTransferSales || 0)
    );

    const availableCash = roundMoney(
      Number(session.sessionOpeningBalance || 0) +
        Number(session.cashSales || 0) -
        Number(session.totalDisbursed || 0)
    );
    if (amount > availableCash) {
      return sendError(
        res,
        `Disbursement exceeds available cash (${availableCash})`,
        400
      );
    }

    const timestamp = new Date();
    const runningCashAfter = roundMoney(availableCash - amount);
    const disbursementId = new mongoose.Types.ObjectId();
    const journalEntry = await postCounterDisbursement({
      amount,
      remarks: cleanedRemarks,
      authorizedBy: String(req.user?.name || ""),
      timestamp,
      postedBy: String(req.user?.id || ""),
      sessionId: String(session._id),
      disbursementId: String(disbursementId),
    });

    const disbursementItem = {
      amount,
      remarks: cleanedRemarks,
      authorizedBy: String(req.user?.name || ""),
      timestamp,
      runningCashAfter,
      journalEntryId: journalEntry?._id || null,
    };
    session.disbursements = [...(session.disbursements || []), disbursementItem];
    session.totalDisbursed = roundMoney(Number(session.totalDisbursed || 0) + amount);
    session.expectedCashInHand = runningCashAfter;
    await session.save();

    await Disbursement.create({
      sessionId: session._id,
      ...disbursementItem,
      createdBy: req.user?.id,
    });

    const allDisbursements = [...(session.disbursements || [])];

    return sendSuccess(
      res,
      {
        disbursement: disbursementItem,
        disbursements: allDisbursements,
        sessionId: String(session._id),
        availableCashBefore: availableCash,
        availableCashAfter: runningCashAfter,
        totalDisbursed: session.totalDisbursed,
        expectedCashInHand: runningCashAfter,
      },
      "Cash disbursed",
      201
    );
  } catch (error: any) {
    console.error("Counter disbursement error:", error);
    return sendError(res, error?.message || "Failed to disburse cash", 500);
  }
});

export default router;
