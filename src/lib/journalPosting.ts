import mongoose, { ClientSession } from "mongoose";
import LedgerAccount from "../models/LedgerAccount";
import JournalEntry from "../models/JournalEntry";
import Setting from "../models/Setting";
import Period from "../models/Period";

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

export async function getSettingValue<T = unknown>(key: string): Promise<T | null> {
  const doc = await (Setting as any).findOne({ key }).lean();
  if (!doc) return null;
  return doc.value as T;
}

export async function resolveLedgerAccountFromSetting(settingKey: string): Promise<any | null> {
  const accountId = String(await getSettingValue<string>(settingKey) || "").trim();
  if (!accountId || !mongoose.Types.ObjectId.isValid(accountId)) return null;
  return LedgerAccount.findOne({ _id: new mongoose.Types.ObjectId(accountId), isActive: true }).lean();
}

export async function resolveLedgerAccountBySettingOrFallback(
  settingKey: string,
  fallbackLookups: Array<Record<string, unknown>>
): Promise<any | null> {
  const account = await resolveLedgerAccountFromSetting(settingKey);
  if (account) return account;
  return resolveFirstLedgerAccount(fallbackLookups);
}

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

async function resolveFirstLedgerAccount(
  lookups: Array<Record<string, unknown>>
): Promise<any | null> {
  for (const lookup of lookups) {
    const account = await findLedgerAccount(lookup);
    if (account) return account;
  }
  return null;
}

function buildLooseRegexFromCategory(category: string): RegExp | null {
  const normalized = String(category || "").trim().toLowerCase();
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = escaped.split(/[^a-z0-9]+/i).filter(Boolean);
  if (!tokens.length) return null;
  return new RegExp(tokens.join("|"), "i");
}

export async function resolveExpenseDebitAccount(
  category: string
): Promise<any | null> {
  const categoryRegex = buildLooseRegexFromCategory(category);
  const isEmployeeExpense = /employee|salary|wage|payroll|staff/i.test(
    category || ""
  );
  const lookups: Array<Record<string, unknown>> = [];

  if (isEmployeeExpense) {
    lookups.push(
      { type: "expense", title: /employee|salary|wage|payroll|staff/i },
      { type: "expense", subcategory: "operating", title: /employee|salary|wage|payroll|staff/i }
    );
  }
  if (categoryRegex) {
    lookups.push(
      { type: "expense", title: categoryRegex },
      { type: "expense", "metadata.category": String(category || "").trim() }
    );
  }
  lookups.push({ type: "expense", subcategory: "operating" }, { type: "expense" });

  return resolveFirstLedgerAccount(lookups);
}

export async function resolveExpensePaymentAccount(
  paymentMethod: string
): Promise<any | null> {
  const method = String(paymentMethod || "").toLowerCase();
  
  // Priority 1: Check Settings for default cash/bank account
  if (method === "bank_transfer" || method === "card") {
    const settingAccount = await resolveLedgerAccountFromSetting("defaultBankAccountId");
    if (settingAccount) return settingAccount;
  } else {
    // For cash payments, try cash account setting first
    const settingAccount = await resolveLedgerAccountFromSetting("defaultCashAccountId");
    if (settingAccount) return settingAccount;
  }
  
  // Priority 2: Fallback to type/title matching
  if (method === "bank_transfer") {
    return resolveFirstLedgerAccount([
      { type: { $in: ["asset", "bank"] }, title: /bank|cash at bank/i },
      { type: { $in: ["asset", "bank"] }, subcategory: "cash" },
      { type: { $in: ["asset", "bank"] } },
    ]);
  }
  if (method === "card") {
    return resolveFirstLedgerAccount([
      { type: { $in: ["asset", "bank"] }, title: /card|bank/i },
      { type: { $in: ["asset", "bank"] } },
    ]);
  }
  return resolveFirstLedgerAccount([
    { type: { $in: ["asset", "bank"] }, title: /cash|petty cash|cash in hand/i },
    { type: { $in: ["asset", "bank"] }, subcategory: "cash" },
    { type: { $in: ["asset", "bank"] } },
  ]);
}

export async function resolvePurchasePostingAccounts(
  supplierId: string,
  options?: { paymentMethod?: string; paymentAccountId?: string }
): Promise<{ inventoryAccount: any | null; paymentAccount: any | null }> {
  const normalizedSupplierId = String(supplierId || "").trim();
  const method = String(options?.paymentMethod || "credit").toLowerCase();

  let paymentAccount: any | null = null;
  if (options?.paymentAccountId && mongoose.Types.ObjectId.isValid(options.paymentAccountId)) {
    paymentAccount = await LedgerAccount.findOne({ _id: new mongoose.Types.ObjectId(options.paymentAccountId), isActive: true }).lean();
  }

  // Priority 1: Supplier-specific payable account
  const supplierSpecificPayable = normalizedSupplierId
    ? await resolveFirstLedgerAccount([
        { type: "liability", subcategory: "accounts-payable", supplierId: normalizedSupplierId },
        { type: "liability", subcategory: "payable", supplierId: normalizedSupplierId },
        { type: "liability", supplierId: normalizedSupplierId },
      ])
    : null;

  // Priority 2: Default A/P from Settings, or fallback to generic payable
  const defaultPayable = supplierSpecificPayable
    || (await resolveLedgerAccountBySettingOrFallback("defaultAPAccountId", [
      { type: "liability", subcategory: "accounts-payable" },
      { type: "liability", subcategory: "payable", title: /payable|supplier|creditor/i },
      { type: "liability", subcategory: "payable" },
      { type: "liability" },
    ]));

  if (method === "cash") {
    paymentAccount = paymentAccount || await resolveExpensePaymentAccount("cash");
  } else {
    paymentAccount = paymentAccount || defaultPayable;
  }

  const inventoryAccount = await resolveLedgerAccountBySettingOrFallback("defaultInventoryAccountId", [
    { type: "asset", subcategory: "inventory" },
    { title: /inventory|stock/i },
    { type: "asset" },
  ]);

  return { inventoryAccount, paymentAccount };
}

export async function resolvePosPostingAccounts(
  paymentMethod: string
): Promise<{
  paymentAccount: any | null;
  revenueAccount: any | null;
  taxAccount: any | null;
  serviceAccount: any | null;
  discountAccount: any | null;
  cogsAccount: any | null;
  inventoryAccount: any | null;
}> {
  const paymentAccount = await resolveExpensePaymentAccount(paymentMethod);
  
  const revenueAccount = await resolveLedgerAccountBySettingOrFallback("defaultSalesAccountId", [
    { type: "revenue", subcategory: "sales" },
    { type: "revenue", title: /sales|revenue/i },
    { type: "revenue" },
  ]);
  
  const taxAccount = await resolveLedgerAccountBySettingOrFallback("defaultTaxPayableAccountId", [
    { type: "liability", subcategory: "tax_payable" },
    { type: "liability", subcategory: "tax-payable" },
    { type: "liability", title: /tax|gst|vat/i },
    { type: "liability" },
  ]);
  
  const serviceAccount = await resolveLedgerAccountBySettingOrFallback("defaultServiceChargeAccountId", [
    { type: "revenue", subcategory: "service" },
    { type: "revenue", title: /service/i },
    { type: "revenue" },
  ]);
  
  const discountAccount = await resolveLedgerAccountBySettingOrFallback("defaultDiscountAccountId", [
    { type: "expense", subcategory: "discounts" },
    { type: "expense", title: /discount|allowance|rebate/i },
    { type: "revenue", title: /discount|allowance|rebate/i },
    { type: "expense" },
  ]);
  
  const cogsAccount = await resolveLedgerAccountBySettingOrFallback("defaultCogsAccountId", [
    { type: "expense", subcategory: "cogs" },
    { type: "expense", title: /cost of goods sold|cogs|cost/i },
    { type: "expense" },
  ]);
  
  const inventoryAccount = await resolveLedgerAccountBySettingOrFallback("defaultInventoryAccountId", [
    { type: "asset", subcategory: "inventory" },
    { title: /inventory|stock/i },
    { type: "asset" },
  ]);

  return {
    paymentAccount,
    revenueAccount,
    taxAccount,
    serviceAccount,
    discountAccount,
    cogsAccount,
    inventoryAccount,
  };
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

export async function createJournalEntryRecord(payload: Record<string, unknown>): Promise<any> {
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

  // Check if posting to a closed or locked period (unless it's a closing entry)
  if (source !== "CLOSING") {
    const entryDate = new Date(date as string | Date);
    const closedPeriodQuery = Period.findOne({
      startDate: { $lte: entryDate },
      endDate: { $gte: entryDate },
      status: { $in: ["closed", "locked"] },
    });
    if (session) closedPeriodQuery.session(session);
    const closedPeriod = await closedPeriodQuery;
    
    if (closedPeriod) {
      throw new Error(`Cannot post to ${closedPeriod.status} period: ${closedPeriod.name}. Reopen the period first or change the entry date.`);
    }
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
  const entry = (await JournalEntry.create(
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
  )) as any;

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
