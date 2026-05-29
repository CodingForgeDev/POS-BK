import mongoose from "mongoose";
import JournalEntry from "../models/JournalEntry";
import CounterSession from "../models/CounterSession";
import {
  createJournalEntryRecord,
  resolveExpenseDebitAccount,
  resolveExpensePaymentAccount,
  resolveLedgerAccountFromSetting,
} from "./journalPosting";

const roundToCents = (value: number) => Number(Number(value || 0).toFixed(2));

export type CounterClosePayload = {
  countedTotal: number;
  openingBalance: number;
  depositedAmount: number;
  remarks?: string;
  closedAt: Date;
  counterOpenedAt: Date;
  postedBy: string;
  sessionId?: string;
};

export type CounterDisbursementPayload = {
  amount: number;
  remarks: string;
  authorizedBy: string;
  timestamp: Date;
  postedBy: string;
  sessionId?: string;
  /** Unique id per disbursement — required so multiple journals per session are allowed */
  disbursementId?: string;
};

function denomRecordToArray(
  denomQty: Record<string, number> | Array<{ denom: number; qty: number }> | undefined
): Array<{ denom: number; qty: number }> {
  if (!denomQty) return [];
  if (Array.isArray(denomQty)) {
    return denomQty.map((d) => ({ denom: Number(d.denom), qty: Number(d.qty || 0) }));
  }
  return Object.entries(denomQty).map(([denom, qty]) => ({
    denom: Number(denom),
    qty: Number(qty || 0),
  }));
}

function formatCounterCloseReference(closedAt: Date, seq: number): string {
  const dateStr = closedAt.toISOString().slice(0, 10).replace(/-/g, "");
  const width = Math.max(4, String(seq).length);
  return `COUNTER-CLOSE-${dateStr}-${String(seq).padStart(width, "0")}`;
}

export function resolveSessionDepositAmount(session: Record<string, unknown>): number {
  const explicit = roundToCents(Number(session.depositedAmount ?? session.netDeposit ?? NaN));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const counted = roundToCents(Number(session.countedTotal || 0));
  const opening = roundToCents(
    Number(session.tomorrowOpening ?? session.openingBalance ?? 0)
  );
  if (counted > 0) {
    return roundToCents(Math.max(0, counted - opening));
  }
  return 0;
}

/** Global sequential counter-close reference: COUNTER-CLOSE-YYYYMMDD-0001 (never resets daily). */
export async function allocateCounterCloseReference(closedAt: Date): Promise<string> {
  const entries = await JournalEntry.find({ source: "COUNTER_CLOSE" })
    .select("reference")
    .lean();

  let maxSeq = 0;
  for (const entry of entries) {
    const ref = String(entry.reference || "");
    const match = ref.match(/^COUNTER-CLOSE-\d{8}-(\d+)$/);
    if (!match) continue;
    const suffix = match[1];
    if (suffix.length > 6) continue;
    maxSeq = Math.max(maxSeq, Number.parseInt(suffix, 10));
  }

  return formatCounterCloseReference(closedAt, maxSeq + 1);
}

/** Renumber all counter-close journals to global sequential refs ordered by close date. */
export async function normalizeCounterCloseReferences(): Promise<number> {
  const entries = await JournalEntry.find({ source: "COUNTER_CLOSE" })
    .sort({ date: 1, _id: 1 })
    .select("_id reference date")
    .lean();

  let updated = 0;
  let seq = 0;
  for (const entry of entries) {
    seq += 1;
    const expected = formatCounterCloseReference(new Date(entry.date as Date), seq);
    if (String(entry.reference || "") !== expected) {
      await JournalEntry.updateOne({ _id: entry._id }, { $set: { reference: expected } });
      updated += 1;
    }
  }
  return updated;
}

/** Backfill missing bank journals for all closed counter sessions with a deposit. */
export async function repairAllMissingCounterCloseJournals(
  filterOpenedBy?: string
): Promise<number> {
  const query: Record<string, unknown> = {
    status: "closed",
    closeJournalEntryId: null,
  };
  if (filterOpenedBy) {
    query.openedBy = filterOpenedBy;
  }

  const sessions = await CounterSession.find(query)
    .sort({ closedAt: 1 })
    .limit(500)
    .lean();

  let repaired = 0;
  for (const session of sessions) {
    const deposited = resolveSessionDepositAmount(session as Record<string, unknown>);
    if (deposited <= 0) continue;

    try {
      const { journal, repaired: didRepair } = await repairCounterCloseJournal({
        ...(session as Record<string, unknown>),
        depositedAmount: deposited,
        netDeposit: deposited,
      });

      if (journal?._id) {
        await CounterSession.updateOne(
          { _id: session._id },
          {
            $set: {
              closeJournalEntryId: journal._id,
              depositedAmount: deposited,
              netDeposit: deposited,
            },
          }
        );
        if (didRepair) repaired += 1;
      }
    } catch (error) {
      console.error("Counter close journal repair failed:", session._id, error);
    }
  }

  return repaired;
}

export async function syncCounterCloseAccounting(
  filterOpenedBy?: string
): Promise<{ journalsRepaired: number; referencesNormalized: number }> {
  const journalsRepaired = await repairAllMissingCounterCloseJournals(filterOpenedBy);
  const referencesNormalized = await normalizeCounterCloseReferences();
  return { journalsRepaired, referencesNormalized };
}

/**
 * Creates the bank deposit journal for a closed counter session that never received one
 * (e.g. journal failed after session save, or legacy closes before accounting integration).
 */
export async function repairCounterCloseJournal(
  session: Record<string, unknown>
): Promise<{ journal: any | null; repaired: boolean }> {
  const sessionId = String(session._id || "");
  if (!sessionId || session.closeJournalEntryId) {
    return { journal: null, repaired: false };
  }

  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return { journal: null, repaired: false };
  }

  const sourceObjectId = new mongoose.Types.ObjectId(sessionId);
  const existing = await JournalEntry.findOne({
    source: "COUNTER_CLOSE",
    sourceId: sourceObjectId,
  }).lean();
  if (existing) {
    return { journal: existing, repaired: false };
  }

  const deposited = resolveSessionDepositAmount(session);
  if (deposited <= 0) {
    return { journal: null, repaired: false };
  }

  const closedAt = session.closedAt ? new Date(session.closedAt as Date) : new Date();
  const openedAt = session.openedAt ? new Date(session.openedAt as Date) : closedAt;

  const journal = await postCounterCloseDeposit({
    countedTotal: Number(session.countedTotal || 0),
    openingBalance: Number(session.openingBalance ?? session.tomorrowOpening ?? 0),
    depositedAmount: deposited,
    remarks: String(session.remarks || ""),
    closedAt,
    counterOpenedAt: openedAt,
    postedBy: String(session.closedBy || ""),
    sessionId,
  });

  return { journal, repaired: Boolean(journal?._id) };
}

/**
 * Posts counter close deposit: physical count minus opening float left in drawer.
 * Dr Bank, Cr Cash on Hand for net deposited amount.
 */
export async function postCounterCloseDeposit(
  payload: CounterClosePayload
): Promise<any | null> {
  const deposited = roundToCents(payload.depositedAmount);
  if (deposited <= 0) return null;

  const cashAccount = await resolveExpensePaymentAccount("cash");
  const bankAccount =
    (await resolveLedgerAccountFromSetting("defaultBankAccountId")) ||
    (await resolveExpensePaymentAccount("bank_transfer"));

  if (!cashAccount?._id) {
    throw new Error(
      "Cash on Hand account is not configured. Set default cash account in Chart of Accounts / Settings."
    );
  }
  if (!bankAccount?._id) {
    throw new Error(
      "Bank account is not configured. Set default bank account in Settings before depositing counter cash."
    );
  }

  const reference = await allocateCounterCloseReference(payload.closedAt);
  const remarkNote = payload.remarks?.trim() ? ` — ${payload.remarks.trim()}` : "";
  const description =
    `Counter close: deposit ${deposited} (counted ${roundToCents(payload.countedTotal)}, ` +
    `opening float ${roundToCents(payload.openingBalance)} retained in drawer)${remarkNote}`;

  const sourceId =
    payload.sessionId && mongoose.Types.ObjectId.isValid(payload.sessionId)
      ? new mongoose.Types.ObjectId(payload.sessionId)
      : new mongoose.Types.ObjectId();

  return createJournalEntryRecord({
    date: payload.closedAt,
    reference,
    description,
    lines: [
      {
        account: bankAccount._id,
        accountName: bankAccount.title,
        debit: deposited,
        credit: 0,
        note: "Cash deposited from counter close",
      },
      {
        account: cashAccount._id,
        accountName: cashAccount.title,
        debit: 0,
        credit: deposited,
        note: "Cash removed from drawer (net of opening float)",
      },
    ],
    source: "COUNTER_CLOSE",
    sourceId,
    postedBy: payload.postedBy,
    status: "posted",
  });
}

/**
 * Posts counter cash disbursement:
 * Dr Petty Cash/Expense, Cr Cash on Hand.
 */
export async function postCounterDisbursement(
  payload: CounterDisbursementPayload
): Promise<any> {
  const amount = roundToCents(payload.amount);
  if (amount <= 0) {
    throw new Error("Disbursement amount must be greater than zero");
  }

  const cashAccount = await resolveExpensePaymentAccount("cash");
  const debitAccount =
    (await resolveLedgerAccountFromSetting("defaultPettyCashAccountId")) ||
    (await resolveExpenseDebitAccount("petty cash")) ||
    (await resolveExpenseDebitAccount("operating"));

  if (!cashAccount?._id) {
    throw new Error(
      "Cash on Hand account is not configured. Set default cash account in Chart of Accounts / Settings."
    );
  }
  if (!debitAccount?._id) {
    throw new Error(
      "Petty cash or expense debit account is not configured. Set default petty cash account in Settings."
    );
  }

  const reference = `COUNTER-DISBURSE-${payload.timestamp.toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now()}`;
  const sourceId =
    payload.disbursementId && mongoose.Types.ObjectId.isValid(payload.disbursementId)
      ? new mongoose.Types.ObjectId(payload.disbursementId)
      : new mongoose.Types.ObjectId();

  return createJournalEntryRecord({
    date: payload.timestamp,
    reference,
    description: `Counter disbursement ${amount} authorized by ${payload.authorizedBy}${payload.remarks ? ` — ${payload.remarks}` : ""}`,
    lines: [
      {
        account: debitAccount._id,
        accountName: debitAccount.title,
        debit: amount,
        credit: 0,
        note: payload.remarks || "Counter cash disbursement",
      },
      {
        account: cashAccount._id,
        accountName: cashAccount.title,
        debit: 0,
        credit: amount,
        note: "Cash moved out of drawer",
      },
    ],
    source: "COUNTER_DISBURSE",
    sourceId,
    postedBy: payload.postedBy,
    status: "posted",
  });
}

export { denomRecordToArray };
