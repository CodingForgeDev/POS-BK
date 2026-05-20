import mongoose, { ClientSession } from "mongoose";
import LedgerAccount from "../models/LedgerAccount";
import JournalEntry from "../models/JournalEntry";
import Setting from "../models/Setting";
import Period from "../models/Period";

const roundToCents = (value: number) => Number(Number(value || 0).toFixed(2));

export const normalizeJournalLines = (lines: any[]) => {
  return (lines || [])
    .map((line) => {
      const debit = roundToCents(Number(line.debit || 0));
      const credit = roundToCents(Number(line.credit || 0));
      return {
        account: line.account,
        accountName: String(line.accountName || "").trim(),
        debit,
        credit,
        note: String(line.note || "").trim(),
      };
    })
    .filter((line) =>
      line.account &&
      ((line.debit > 0 && line.credit === 0) || (line.credit > 0 && line.debit === 0))
    );
};

export const validateJournalBalance = (lines: any[]) => {
  const totalDebit = roundToCents(lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0));
  const totalCredit = roundToCents(lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0));
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

function normalizePaymentAccounts(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

export async function resolveExpenseDebitAccount(
  category: string
): Promise<any | null> {
  const categoryString = String(category || "").trim();
  const categoryRegex = buildLooseRegexFromCategory(categoryString);
  const lookups: Array<Record<string, unknown>> = [];

  if (categoryString) {
    lookups.push({ type: "expense", subcategory: categoryString });
  }
  if (categoryRegex) {
    lookups.push(
      { type: "expense", title: categoryRegex },
      { type: "expense", "metadata.category": categoryString }
    );
  }

  const isEmployeeExpense = /employee|salary|wage|payroll|staff/i.test(categoryString);
  if (isEmployeeExpense) {
    lookups.unshift({ type: "expense", subcategory: "payroll" });
    lookups.unshift({ type: "expense", title: /employee|salary|wage|payroll|staff/i });
  }

  lookups.push({ type: "expense", subcategory: "operating" }, { type: "expense" });

  return resolveFirstLedgerAccount(lookups);
}

export async function resolveExpensePaymentAccount(
  paymentMethod: string
): Promise<any | null> {
  const method = String(paymentMethod || "").toLowerCase();
  const paymentAccounts = normalizePaymentAccounts(await getSettingValue<any[]>("paymentAccounts"));

  if (Array.isArray(paymentAccounts) && paymentAccounts.length > 0) {
    const matchedAccount = paymentAccounts.find(
      (account: any) => String(account.method || "").toLowerCase() === method && account.ledgerAccountId && mongoose.Types.ObjectId.isValid(account.ledgerAccountId)
    );
    if (matchedAccount) {
      const account = await LedgerAccount.findOne({
        _id: new mongoose.Types.ObjectId(String(matchedAccount.ledgerAccountId)),
        isActive: true,
      }).lean();
      if (account) return account;
    }
  }

  // Priority 1: Check Settings for default cash/bank account
  if (method === "bank_transfer" || method === "card") {
    const settingAccount = await resolveLedgerAccountFromSetting("defaultBankAccountId");
    if (settingAccount) return settingAccount;
  } else {
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

  let paymentAccount: any = null;
  
  if (selectedAccount) {
    paymentAccount = selectedAccount;
  } else if (returnType === "sale") {
    paymentAccount = await findLedgerAccountByFallback(
      { type: { $in: ["asset", "bank", "receivable"] }, title: /cash|bank|receivable|customer/i },
      { type: "asset" },
      { type: "bank" },
      { type: "receivable" }
    );
  } else {
    // For purchase returns, try to get supplier from linked purchase
    let supplierId: string | null = null;
    if (returnRecord.purchaseId && mongoose.Types.ObjectId.isValid(String(returnRecord.purchaseId))) {
      const Purchase = mongoose.models.Purchase || mongoose.model("Purchase");
      const purchaseQuery = Purchase.findById(returnRecord.purchaseId).select("supplier").lean();
      if (session) purchaseQuery.session(session);
      const purchase = (await purchaseQuery) as { supplier?: unknown } | null;
      if (purchase?.supplier) {
        supplierId = String(purchase.supplier);
      }
    }

    // Try supplier-specific payable first, then default accounts payable
    if (supplierId) {
      paymentAccount = await resolveFirstLedgerAccount([
        { type: "liability", subcategory: "accounts-payable", supplierId },
        { type: "liability", subcategory: "payable", supplierId },
        { type: "liability", supplierId },
      ]);
    }

    // Fallback to default Accounts Payable (not generic liability which includes GST)
    if (!paymentAccount) {
      paymentAccount = await resolveLedgerAccountBySettingOrFallback("defaultAPAccountId", [
        { type: "liability", subcategory: "accounts-payable" },
        { type: "liability", subcategory: "payable", title: /payable|supplier|creditor|account.*payable/i },
        { type: "liability", title: /account.*payable|payable.*account|supplier.*payable|creditor/i },
      ]);
    }
  }

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

  // For purchase returns, split GST separately
  let lines: any[] = [];

  if (returnType === "sale") {
    lines = [
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
    ];
  } else {
    // Purchase return: Split GST using default GST rate
    const { getGstRateForMethod } = await import("./gst");
    const gstRatePct = await getGstRateForMethod("default");
    
    // Calculate GST amount: gst = totalAmount / (1 + rate/100) * (rate/100)
    const preGstAmount = Math.round((amount / (1 + gstRatePct / 100)) * 100) / 100;
    const gstAmount = Math.round((amount - preGstAmount) * 100) / 100;

    // Resolve tax input account for GST credit
    const taxAccount = await resolveLedgerAccountBySettingOrFallback(
      "defaultTaxInputAccountId",
      [
        { type: "asset", subcategory: "tax_input" },
        { type: "asset", subcategory: "tax-input" },
        { type: "asset", title: /gst|tax.*input|input.*tax/i },
        { type: "asset", title: /tax|gst|vat/i },
      ]
    );

    // Journal lines for purchase return with GST split
    lines = [
      {
        account: paymentAccount._id,
        accountName: paymentAccount.title,
        debit: amount,
        credit: 0,
        note: `Purchase return payment reduction ${reference}`,
      },
    ];

    if (gstAmount > 0 && taxAccount) {
      lines.push({
        account: taxAccount._id,
        accountName: taxAccount.title,
        debit: gstAmount,
        credit: 0,
        note: `GST input reversal for ${reference}`,
      });
    }

    lines.push({
      account: contraAccount._id,
      accountName: contraAccount.title,
      debit: 0,
      credit: preGstAmount,
      note: `Purchase return inventory adjustment ${reference}`,
    });

    // If GST line couldn't be resolved, credit it against payable
    if (gstAmount > 0 && !taxAccount) {
      lines.push({
        account: paymentAccount._id,
        accountName: paymentAccount.title,
        debit: 0,
        credit: gstAmount,
        note: `GST input reversal for ${reference}`,
      });
    }
  }

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

  // Update ledger account running balances so Chart of Accounts reflects journal-posted changes.
  const accountBalanceChanges = new Map<string, { accountId: any; debit: number; credit: number }>();
  for (const line of preparedLines) {
    const accountId = String(line.account);
    const existing = accountBalanceChanges.get(accountId);
    if (existing) {
      existing.debit += Number(line.debit || 0);
      existing.credit += Number(line.credit || 0);
    } else {
      accountBalanceChanges.set(accountId, {
        accountId: line.account,
        debit: Number(line.debit || 0),
        credit: Number(line.credit || 0),
      });
    }
  }

  for (const accountBalanceChange of Array.from(accountBalanceChanges.values())) {
    const { accountId, debit, credit } = accountBalanceChange;
    const account = await LedgerAccount.findById(accountId).session(session || undefined).lean() as unknown as { type: string } | null;
    if (!account) continue;
    const normalDebit = ["asset", "bank", "receivable", "expense"].includes(account.type);
    const delta = normalDebit ? debit - credit : credit - debit;
    if (delta !== 0) {
      const updateQuery = LedgerAccount.updateOne(
        { _id: accountId },
        { $inc: { currentBalance: delta } }
      );
      if (session) updateQuery.session(session);
      await updateQuery;
    }
  }

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

/**
 * Create a full sale return journal reversal, with option to change payment account based on refund method
 * This reverses ALL accounts from the original sale (revenue, COGS, inventory, GST, receivables)
 * and allows selecting different payment method (cash vs bank)
 */
export async function createSaleReturnJournalReversal(
  originalEntry: any,
  refundMethod: string = "cash",
  payload: Record<string, unknown> = {}
) {
  if (!originalEntry || !Array.isArray(originalEntry.lines) || originalEntry.lines.length === 0) {
    throw new Error("Original journal entry is required for reversal");
  }

  // Extract proportion from payload (default 1.0 = 100% for full refund)
  const proportion = Number(payload.proportion ?? 1.0);
  if (proportion <= 0 || proportion > 1.0) {
    throw new Error("Proportion must be between 0 and 1.0 (0-100%)");
  }

  // Validate refund method
  const validMethods = ["cash", "bank"];
  const normalizedMethod = String(refundMethod || "cash").trim().toLowerCase();
  if (!validMethods.includes(normalizedMethod)) {
    throw new Error(`Invalid refund method: ${normalizedMethod}. Must be one of: ${validMethods.join(", ")}`);
  }

  // Reverse all lines with proportional amounts and handle payment account substitution
  let reversalLines: any[] = [];
  let paymentLineIndex = -1;
  let paymentLineFound = false;

  for (let i = 0; i < originalEntry.lines.length; i++) {
    const line = originalEntry.lines[i];
    const reversedLine = {
      account: line.account,
      accountName: line.accountName,
      debit: Math.round(Number(line.credit || 0) * proportion * 100) / 100,
      credit: Math.round(Number(line.debit || 0) * proportion * 100) / 100,
      note: `${proportion < 1.0 ? `Partial refund (${(proportion * 100).toFixed(1)}%)` : "Reversal"} of: ${String(line.note || line.accountName || "journal line")}`,
    };

    // Try to detect if this is the payment account line (first debit line or line with cash/bank keywords)
    if (!paymentLineFound && Number(line.debit || 0) > 0) {
      const noteStr = String(line.note || "").toLowerCase();
      const accountNameStr = String(line.accountName || "").toLowerCase();
      
      // Check if this looks like a payment line (POS order line is typically the first one)
      if (noteStr.includes("pos order") || accountNameStr.match(/cash|bank|receivable|customer/i)) {
        paymentLineIndex = reversalLines.length;
        paymentLineFound = true;
      }
    }

    reversalLines.push(reversedLine);
  }

  // If payment line found, replace its account with the selected refund method account
  if (paymentLineFound && paymentLineIndex >= 0) {
    let newPaymentAccount: any = null;
    
    if (normalizedMethod === "cash") {
      newPaymentAccount = await findLedgerAccountByFallback(
        { type: "asset", title: /cash|petty/i },
        { type: "asset", title: /cash/i },
        { type: "bank", title: /cash/i }
      );
    } else if (normalizedMethod === "bank") {
      newPaymentAccount = await findLedgerAccountByFallback(
        { type: "bank", title: /bank|cheque/i },
        { type: "asset", title: /bank/i },
        { type: "asset", title: /receivable/i }
      );
    }

    if (newPaymentAccount) {
      reversalLines[paymentLineIndex].account = newPaymentAccount._id;
      reversalLines[paymentLineIndex].accountName = newPaymentAccount.title;
      reversalLines[paymentLineIndex].note = `Refund (${normalizedMethod}, ${(proportion * 100).toFixed(1)}%): ${reversalLines[paymentLineIndex].note}`;
    }
  }

  return createJournalEntryRecord({
    date: payload.date || new Date(),
    reference: String(payload.reference || `REV-${originalEntry.reference || originalEntry._id}`).trim(),
    description: String(
      payload.description ||
      `${proportion < 1.0 ? `Partial (${(proportion * 100).toFixed(1)}%)` : "Full"} sale return reversal (${normalizedMethod}) for ${originalEntry.reference || originalEntry._id}`
    ).trim(),
    lines: reversalLines,
    source: "MANUAL",
    sourceId: null,
    postedBy: payload.postedBy || null,
    status: String(payload.status || "posted"),
  });
}
