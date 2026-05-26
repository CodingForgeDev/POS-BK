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
} from "../lib/counterPosting";

const router = Router();

const roundMoney = (v: unknown) => Number(Number(v || 0).toFixed(2));
const roleCanDisburse = (role: unknown) =>
  ["admin", "manager"].includes(String(role || "").trim().toLowerCase());

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
    const openSessionRaw = await CounterSession.findOne({ status: "open" })
      .sort({ openedAt: -1 })
      .lean();

    const openSession = await hydrateOpenSession(openSessionRaw as Record<string, unknown> | null);

    const lastClosed = await CounterSession.findOne({ status: "closed" })
      .sort({ closedAt: -1 })
      .lean();

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
    });
  } catch (error) {
    console.error("Counter status error:", error);
    return sendError(res, "Failed to load counter status", 500);
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

    let session = sessionId
      ? await CounterSession.findOne({ _id: sessionId, status: "open" })
      : await CounterSession.findOne({ status: "open" }).sort({ openedAt: -1 });
    if (!session) {
      session = new CounterSession({
        status: "open",
        openedAt,
        openedBy: req.user?.id,
        cashierName: String(cashierName || req.user?.name || ""),
      });
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

    const existingOpen = await CounterSession.findOne({ status: "open" });
    if (existingOpen) {
      return sendError(res, "A counter session is already open", 409);
    }

    const { openedAt, cashierName = "" } = req.body || {};
    const openedAtDate = openedAt ? new Date(openedAt) : new Date();
    if (Number.isNaN(openedAtDate.getTime())) {
      return sendError(res, "Invalid open timestamp", 400);
    }

    const lastClosed = await CounterSession.findOne({ status: "closed" })
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

    let session = sessionId
      ? await CounterSession.findOne({ _id: sessionId, status: "open" })
      : await CounterSession.findOne({ status: "open" }).sort({ openedAt: -1 });

    if (!session && counterOpenedAt) {
      const openedAtDate = new Date(counterOpenedAt);
      if (!Number.isNaN(openedAtDate.getTime())) {
        const lastClosed = await CounterSession.findOne({ status: "closed" })
          .sort({ closedAt: -1 })
          .lean();
        session = await CounterSession.create({
          status: "open",
          openedAt: openedAtDate,
          openedBy: req.user?.id,
          cashierName: String(req.user?.name || ""),
          sessionOpeningBalance: roundMoney(
            lastClosed?.tomorrowOpening || lastClosed?.openingBalance || 0
          ),
          openingBalance: roundMoney(lastClosed?.openingBalance || 0),
          openingDenominations: lastClosed?.openingDenominations || [],
        });
      }
    }

    if (!session) return sendError(res, "No open counter session found", 404);

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
