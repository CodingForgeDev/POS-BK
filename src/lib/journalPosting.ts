import mongoose, { ClientSession } from "mongoose";
import LedgerAccount from "../models/LedgerAccount";
import JournalEntry from "../models/JournalEntry";

export const normalizeJournalLines = (lines: any[]) => {
  return (lines || [])
    .map((line) => ({
      account: line.account,
      accountName: String(line.accountName || "").trim(),
      debit: Number(line.debit || 0),
      credit: Number(line.credit || 0),
      note: String(line.note || "").trim(),
    }))
    .filter((line) =>
      line.account &&
      ((line.debit > 0 && line.credit === 0) || (line.credit > 0 && line.debit === 0))
    );
};

export const validateJournalBalance = (lines: any[]) => {
  const totalDebit = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);
  const totalCredit = lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0);
  return { totalDebit, totalCredit, balanced: totalDebit === totalCredit };
};

export const findLedgerAccount = async (filter: Record<string, unknown>): Promise<any | null> => {
  return LedgerAccount.findOne({ isActive: true, ...filter }).sort({ code: 1 }).lean();
};

export async function findLedgerAccountByFallback(
  primary: Record<string, unknown>,
  ...fallbacks: Array<Record<string, unknown>>
): Promise<any | null> {
  const account = await findLedgerAccount(primary);
  if (account) return account;
  for (const fallback of fallbacks) {
    const fallbackAccount = await findLedgerAccount(fallback);
    if (fallbackAccount) return fallbackAccount;
  }
  return null;
}

export async function createReturnJournalEntry(returnRecord: any, session: ClientSession | null = null) {
  if (!returnRecord) {
    throw new Error("Return record is required for journal entry");
  }

  const amount = Number(returnRecord.totalAmount || 0);
  if (!amount || amount <= 0) {
    throw new Error("Return amount must be greater than zero");
  }

  const returnType = String(returnRecord.returnType || "").trim().toLowerCase();
  const selectedAccountId = returnRecord.account ? String(returnRecord.account) : null;
  let selectedAccount: any = null;
  if (selectedAccountId) {
    if (!mongoose.Types.ObjectId.isValid(selectedAccountId)) {
      throw new Error("Selected ledger account is invalid");
    }
    const selectedQuery = LedgerAccount.findById(selectedAccountId).lean();
    if (session) selectedQuery.session(session);
    selectedAccount = await selectedQuery;
  }

  const paymentAccount = selectedAccount ||
    (returnType === "sale"
      ? await findLedgerAccountByFallback(
          { type: { $in: ["asset", "bank", "receivable"] }, title: /cash|bank|receivable|customer/i },
          { type: "asset" },
          { type: "bank" },
          { type: "receivable" }
        )
      : await findLedgerAccountByFallback(
          { type: { $in: ["liability"] }, title: /payable|supplier|credit/i },
          { type: "liability" },
          { type: "bank" },
          { type: "asset" }
        ));

  const contraAccount =
    returnType === "sale"
      ? await findLedgerAccountByFallback(
          { type: "revenue", title: /sales|revenue|return/i },
          { type: "revenue" },
          { type: "equity" }
        )
      : await findLedgerAccountByFallback(
          { type: "expense", title: /purchase|cost|inventory|return/i },
          { type: "expense" },
          { type: "asset" }
        );

  if (!paymentAccount || !contraAccount) {
    throw new Error("Unable to determine ledger accounts for return journal entry");
  }

  const reference = String(returnRecord.reference || returnRecord._id || "").trim() || `RETURN-${String(returnRecord._id)}`;
  const description = `${returnType === "purchase" ? "Purchase" : "Sale"} return ${reference}`;

  const lines =
    returnType === "sale"
      ? [
          {
            account: contraAccount._id,
            accountName: contraAccount.title,
            debit: amount,
            credit: 0,
            note: `Sales return against ${reference}`,
          },
          {
            account: paymentAccount._id,
            accountName: paymentAccount.title,
            debit: 0,
            credit: amount,
            note: `Sale return payment adjustment ${reference}`,
          },
        ]
      : [
          {
            account: paymentAccount._id,
            accountName: paymentAccount.title,
            debit: amount,
            credit: 0,
            note: `Purchase return payment adjustment ${reference}`,
          },
          {
            account: contraAccount._id,
            accountName: contraAccount.title,
            debit: 0,
            credit: amount,
            note: `Purchase return against ${reference}`,
          },
        ];

  return createJournalEntryRecord({
    date: returnRecord.date || new Date(),
    reference: `RETURN-${reference}`,
    description,
    lines,
    source: "RETURN",
    sourceId: returnRecord._id || null,
    postedBy: null,
    status: "posted",
    session,
  });
}

export async function createJournalEntryRecord(payload: Record<string, unknown>) {
  const {
    date,
    reference,
    description,
    lines,
    source = "MANUAL",
    sourceId = null,
    postedBy = null,
    status = "posted",
  } = payload;
  const session = (payload as { session?: ClientSession | null }).session ?? null;

  if (!date || !Array.isArray(lines) || lines.length === 0) {
    throw new Error("Date and at least one journal line are required");
  }

  const normalizedLines = normalizeJournalLines(lines as any[]);
  if (normalizedLines.length < 2) {
    throw new Error("At least two valid journal lines are required");
  }

  const invalidLine = (lines as any[]).find((line) => {
    const debit = Number(line.debit || 0);
    const credit = Number(line.credit || 0);
    return line.account && line.accountName && ((debit > 0 && credit > 0) || (debit === 0 && credit === 0));
  });
  if (invalidLine) {
    throw new Error("Each journal line must have exactly one nonzero amount on debit or credit");
  }

  const { totalDebit, totalCredit, balanced } = validateJournalBalance(normalizedLines);
  if (!balanced) {
    throw new Error("Journal entry must balance debit and credit");
  }

  const accountIds = normalizedLines.map((line) => String(line.account));
  const existingAccountsQuery = LedgerAccount.find({ _id: { $in: accountIds } }).lean();
  if (session) existingAccountsQuery.session(session);
  const existingAccounts = await existingAccountsQuery;
  const accountMap = Object.fromEntries(existingAccounts.map((acct) => [String(acct._id), acct]));

  const invalidAccount = normalizedLines.find((line) => !accountMap[String(line.account)]);
  if (invalidAccount) {
    throw new Error(`Ledger account not found for line: ${invalidAccount.accountName || String(invalidAccount.account)}`);
  }

  if (source !== "MANUAL" && sourceId) {
    const duplicateQuery = JournalEntry.findOne({ source, sourceId });
    if (session) duplicateQuery.session(session);
    const duplicate = await duplicateQuery;
    if (duplicate) {
      throw new Error("Journal entry already exists for this source");
    }
  }

  const preparedLines = normalizedLines.map((line) => ({
    account: line.account,
    accountName: accountMap[String(line.account)]?.title || line.accountName,
    debit: line.debit,
    credit: line.credit,
    note: line.note,
  }));

  const entryDate = date instanceof Date ? date : new Date(String(date));
  const entry = await JournalEntry.create(
    {
      date: entryDate,
      reference: String(reference || "").trim(),
      description: String(description || "").trim(),
      lines: preparedLines,
      totalDebit,
      totalCredit,
      source,
      sourceId: sourceId || null,
      postedBy: status === "posted" ? postedBy || null : null,
      status,
    },
    session ? { session } : undefined
  );

  return entry;
}

export async function reverseJournalEntryRecord(originalEntry: any, payload: Record<string, unknown> = {}) {
  if (!originalEntry || !Array.isArray(originalEntry.lines) || originalEntry.lines.length === 0) {
    throw new Error("Original journal entry is required for reversal");
  }

  const reversalLines = originalEntry.lines.map((line: any) => ({
    account: line.account,
    accountName: line.accountName,
    debit: Number(line.credit || 0),
    credit: Number(line.debit || 0),
    note: `Reversal of: ${String(line.note || line.accountName || "journal line")}`,
  }));

  return createJournalEntryRecord({
    date: payload.date || new Date(),
    reference: String(payload.reference || `REV-${originalEntry.reference || originalEntry._id}`).trim(),
    description: String(payload.description || `Reversal of journal ${originalEntry.reference || originalEntry._id}`).trim(),
    lines: reversalLines,
    source: "MANUAL",
    sourceId: null,
    postedBy: payload.postedBy || null,
    status: String(payload.status || "posted"),
  });
}
