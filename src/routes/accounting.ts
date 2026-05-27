import { Router, Response } from "express";
import mongoose from "mongoose";
import { connectDB } from "../lib/mongodb";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { sendSuccess, sendError } from "../lib/utils";
import LedgerAccount from "../models/LedgerAccount";
import Employee from "../models/Employee";
import JournalEntry from "../models/JournalEntry";
import ReturnTransaction from "../models/ReturnTransaction";
import Purchase from "../models/Purchase";
import StockLayer from "../models/StockLayer";
import { deductInventoryFifo } from "../lib/inventoryFifo";
import { InsufficientStockError } from "../lib/inventoryErrors";
import {
  createJournalEntryRecord,
  createReturnJournalEntry,
  normalizeJournalLines,
  validateJournalBalance,
  reverseJournalEntryRecord,
  resolvePosPostingAccounts,
} from "../lib/journalPosting";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import { isAdminOrManagerRoleName } from "../lib/role-utils";

async function applyPurchaseReturnInventoryDeduction(returnRecord: any, session: mongoose.ClientSession | null = null) {
  if (!returnRecord || String(returnRecord.returnType).trim().toLowerCase() !== "purchase") {
    return;
  }

  const purchaseId = returnRecord.purchaseId ? String(returnRecord.purchaseId) : null;
  let purchaseSupplier: mongoose.Types.ObjectId | null = null;

  if (purchaseId) {
    const purchase = (await Purchase.findById(purchaseId).lean()) as any;
    if (purchase && purchase.supplier) {
      purchaseSupplier = new mongoose.Types.ObjectId(String(purchase.supplier));
    }
  }

  for (const item of returnRecord.items || []) {
    if (!item || !item.inventoryItemId || Number(item.quantity) <= 0) continue;

    await deductInventoryFifo({
      inventoryItemId: String(item.inventoryItemId),
      quantity: Number(item.quantity),
      session,
      releaseReserved: 0,
      preferredPurchaseIds: purchaseId ? [purchaseId] : undefined,
    });

    const adjustmentLayer: any = {
      sourceType: "adjustment",
      purchase: purchaseId ? new mongoose.Types.ObjectId(purchaseId) : null,
      lineIndex: 0,
      inventoryItem: new mongoose.Types.ObjectId(String(item.inventoryItemId)),
      supplier: purchaseSupplier,
      createdBy: returnRecord.createdBy || null,
      adjustmentType: "remove",
      receivedAt: new Date(),
      quantityOriginal: Number(item.quantity),
      quantityRemaining: 0,
      unitCost: Number(item.unitPrice) || 0,
    };

    const layerOptions = session ? { session } : undefined;
    await StockLayer.create([adjustmentLayer], layerOptions);
  }
}

const router: Router = Router();

const INVENTORY_METADATA_BLACKLIST = ["location", "quantity", "unit", "minLevel", "costMethod", "inventoryItemId"];

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

async function createMissingPosJournalForInvoice(invoice: any) {
  if (!invoice?.order) {
    return { created: false, reason: "Invoice has no linked order" };
  }

  const order = await Order.findById(String(invoice.order)).lean();
  if (!order) {
    return { created: false, reason: "Linked order not found" };
  }

  const existing = await JournalEntry.findOne({
    source: "POS",
    sourceId: order._id,
  }).lean();
  if (existing) {
    return { created: false, reason: "Journal already exists" };
  }

  const total = Number(invoice.total || 0);
  const subtotal = Number(invoice.subtotal || order.subtotal || 0);
  const taxAmount = Number(invoice.taxAmount || 0);
  const serviceChargeAmount = Number(invoice.serviceChargeAmount || 0);
  const orderDiscountAmount = Number(order.discountAmount || 0);
  const paymentAccountDiscountAmount = Number(invoice.paymentAccountDiscountAmount || 0);

  if (total <= 0) {
    return { created: false, reason: "Invoice total is zero" };
  }

  const {
    paymentAccount,
    revenueAccount,
    taxAccount,
    serviceAccount,
    discountAccount: resolvedDiscountAccount,
  } = await resolvePosPostingAccounts(String(invoice.paymentMethod || ""));

  if (!paymentAccount || !revenueAccount || !taxAccount) {
    throw new Error(
      `Missing posting account mapping for invoice ${String(invoice.invoiceNumber || invoice._id)}`
    );
  }

  let discountAccount: any = null;
  if (orderDiscountAmount > 0 || paymentAccountDiscountAmount > 0) {
    discountAccount = resolvedDiscountAccount || revenueAccount;
  }

  const lines: any[] = [
    {
      account: paymentAccount._id,
      accountName: paymentAccount.title,
      debit: total,
      credit: 0,
      note: `POS order ${String((order as any).orderNumber || order._id)}`,
    },
  ];

  if (orderDiscountAmount > 0) {
    lines.push({
      account: discountAccount?._id || revenueAccount._id,
      accountName: discountAccount?.title || revenueAccount.title,
      debit: orderDiscountAmount,
      credit: 0,
      note: `Order discount for ${String((order as any).orderNumber || order._id)}`,
    });
  }

  if (paymentAccountDiscountAmount > 0) {
    lines.push({
      account: discountAccount?._id || revenueAccount._id,
      accountName: discountAccount?.title || revenueAccount.title,
      debit: paymentAccountDiscountAmount,
      credit: 0,
      note: `Payment account discount for ${String((order as any).orderNumber || order._id)}`,
    });
  }

  lines.push(
    {
      account: revenueAccount._id,
      accountName: revenueAccount.title,
      debit: 0,
      credit: subtotal,
      note: `POS sales revenue for ${String((order as any).orderNumber || order._id)}`,
    },
    {
      account: taxAccount._id,
      accountName: taxAccount.title,
      debit: 0,
      credit: taxAmount,
      note: `GST for ${String((order as any).orderNumber || order._id)}`,
    }
  );

  if (serviceChargeAmount > 0) {
    lines.push({
      account: serviceAccount?._id || revenueAccount._id,
      accountName: serviceAccount?.title || revenueAccount.title,
      debit: 0,
      credit: serviceChargeAmount,
      note: `Service charge for ${String((order as any).orderNumber || order._id)}`,
    });
  }

  await createJournalEntryRecord({
    date: invoice.createdAt ? new Date(invoice.createdAt) : new Date(),
    reference: String(invoice.invoiceNumber || ""),
    description: `POS sale invoice ${String(invoice.invoiceNumber || invoice._id)}`,
    lines,
    source: "POS",
    sourceId: order._id,
    postedBy: invoice.issuedBy || null,
    status: "posted",
  });

  return { created: true, reason: "Created" };
}

async function assertSingleInventoryAccount(
  type: string,
  subcategory: string,
  excludeId: string | null = null
) {
  if (String(type).trim() !== "asset" || String(subcategory).trim() !== "inventory") {
    return;
  }
  const query: any = {
    type: "asset",
    subcategory: "inventory",
    isActive: true,
  };
  if (excludeId) query._id = { $ne: new mongoose.Types.ObjectId(String(excludeId)) };
  const existing = await LedgerAccount.findOne(query).lean();
  if (existing) {
    throw new Error("An active Inventory account already exists");
  }
}

router.get("/accounts", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type, subcategory, search, linkedEmployee, includeInactive } = req.query as Record<string, string>;
    const query: any = {};
    if (includeInactive !== "true") {
      query.isActive = true;
    }
    if (type) {
      const typeValue = String(type).trim();
      if (typeValue === "asset") {
        query.type = { $in: ["asset", "bank", "receivable"] };
      } else {
        query.type = typeValue;
      }
    }
    if (subcategory) {
      const subcategoryValue = String(subcategory).trim();
      const normalizedSubcategoryMap: Record<string, string[]> = {
        cash: ["cash", "bank"],
        receivable: ["receivable", "accounts-receivable"],
        payable: ["payable", "accounts-payable"],
        fixed: ["fixed", "fixed-assets"],
        tax_payable: ["tax_payable", "tax-payable"],
      };
      query.subcategory = { $in: normalizedSubcategoryMap[subcategoryValue] || [subcategoryValue] };
    }
    if (search) {
      const text = String(search).trim();
      query.$or = [
        { code: { $regex: text, $options: "i" } },
        { title: { $regex: text, $options: "i" } },
      ];
    }
    if (linkedEmployee) {
      const employeeId = String(linkedEmployee).trim();
      if (mongoose.Types.ObjectId.isValid(employeeId)) {
        query.linkedEmployee = new mongoose.Types.ObjectId(employeeId);
      }
    }
    const accounts = await LedgerAccount.find(query)
      .populate("linkedEmployee", "name position department")
      .sort({ code: 1 })
      .lean();
    return sendSuccess(res, accounts);
  } catch (error) {
    console.error("Accounting accounts error:", error);
    return sendError(res, "Failed to fetch accounts", 500);
  }
});

router.get("/ledger", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { accountId, dateFrom, dateTo } = req.query as Record<string, string>;
    const isAllAccounts = !accountId || accountId === "all";
    let selectedAccount: any = null;

    if (!isAllAccounts) {
      if (!mongoose.Types.ObjectId.isValid(accountId)) {
        return sendError(res, "Ledger account is invalid", 400);
      }
      selectedAccount = await LedgerAccount.findOne({ _id: accountId, isActive: true }).lean();
      if (!selectedAccount) {
        return sendError(res, "Ledger account not found", 404);
      }
    }

    const match: any = {};
    if (!isAllAccounts && selectedAccount?._id) {
      match["lines.account"] = selectedAccount._id;
    }
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        match.date = { ...match.date, $gte: fromDate };
      }
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!Number.isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        match.date = { ...match.date, $lte: toDate };
      }
    }

    const accountLookupMatch: any = { "account.isActive": true };
    if (!isAllAccounts && selectedAccount?._id) {
      accountLookupMatch["account._id"] = selectedAccount._id;
    }

    const entries = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      {
        $lookup: {
          from: "ledgeraccounts",
          localField: "lines.account",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: "$account" },
      { $match: accountLookupMatch },
      { $sort: { date: 1, _id: 1 } },
      {
        $project: {
          _id: 0,
          date: 1,
          reference: 1,
          description: 1,
          note: "$lines.note",
          debit: "$lines.debit",
          credit: "$lines.credit",
          accountId: "$account._id",
          accountCode: "$account.code",
          accountTitle: "$account.title",
          accountType: "$account.type",
        },
      },
    ]);

    const totals = entries.reduce(
      (acc, row) => {
        acc.debit += Number(row.debit || 0);
        acc.credit += Number(row.credit || 0);
        return acc;
      },
      { debit: 0, credit: 0 }
    );

    return sendSuccess(res, {
      account: isAllAccounts ? null : selectedAccount,
      entries,
      totals,
    });
  } catch (error) {
    console.error("Accounting ledger error:", error);
    return sendError(res, "Failed to fetch ledger", 500);
  }
});

router.get("/accounts/:id/ledger", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query as Record<string, string>;

    const account = (await LedgerAccount.findById(String(id)).lean()) as any;
    if (!account || !account.isActive) {
      return sendError(res, "Ledger account not found", 404);
    }

    const match: any = { "lines.account": account._id as any };
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        match.date = { ...match.date, $gte: fromDate };
      }
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!Number.isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        match.date = { ...match.date, $lte: toDate };
      }
    }

    const entries = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      { $match: { "lines.account": account._id as any } },
      { $sort: { date: 1, _id: 1 } },
      {
        $project: {
          _id: 0,
          date: 1,
          reference: 1,
          description: 1,
          note: "$lines.note",
          debit: "$lines.debit",
          credit: "$lines.credit",
        },
      },
    ]);

    const totals = entries.reduce(
      (acc, row) => {
        acc.debit += Number(row.debit || 0);
        acc.credit += Number(row.credit || 0);
        return acc;
      },
      { debit: 0, credit: 0 }
    );

    return sendSuccess(res, {
      account,
      entries,
      totals,
    });
  } catch (error) {
    console.error("Accounting account ledger error:", error);
    return sendError(res, "Failed to fetch account ledger", 500);
  }
});

router.post("/accounts", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const {
      code,
      title,
      type,
      subcategory,
      currency,
      supplierId,
      supplierName,
      paymentTerms,
      isReconcilable,
      metadata,
      address,
      contact,
      openingBalance,
      employeeId,
      linkedEmployeeId,
    } = req.body as Record<string, unknown>;
    if (!code || !title || !type) {
      return sendError(res, "Code, title, and account type are required", 400);
    }
    
    // Validate employee if provided
    const linkedEmpId = linkedEmployeeId || employeeId;
    let linkedEmployee = null;
    if (linkedEmpId) {
      const empIdStr = String(linkedEmpId).trim();
      if (mongoose.Types.ObjectId.isValid(empIdStr)) {
        linkedEmployee = await Employee.findById(empIdStr);
        if (!linkedEmployee) {
          return sendError(res, "Selected employee not found", 404);
        }
      }
    }
    
    const normalizedMetadata = sanitizeMetadata(metadata);
    const accountType = String(type).trim();
    const accountSubcategory = String(subcategory || "").trim();
    await assertSingleInventoryAccount(accountType, accountSubcategory);
    if (accountType === "asset" && accountSubcategory === "inventory") {
      const invalidMetadata = INVENTORY_METADATA_BLACKLIST.filter((key) => normalizedMetadata[key] !== undefined);
      if (invalidMetadata.length) {
        return sendError(res, `Inventory account cannot contain item-level metadata: ${invalidMetadata.join(", ")}`, 400);
      }
    }
    const account = await LedgerAccount.create({
      code: String(code).trim(),
      title: String(title).trim(),
      type: accountType,
      subcategory: accountSubcategory,
      currency: String(currency || "PKR").trim(),
      supplierId: String(supplierId || "").trim(),
      supplierName: String(
        supplierName || normalizedMetadata.supplierName || ""
      ).trim(),
      paymentTerms: String(paymentTerms || "").trim(),
      isReconcilable: Boolean(isReconcilable),
      metadata: normalizedMetadata,
      address: String(address || "").trim(),
      contact: String(contact || "").trim(),
      openingBalance: Number(openingBalance || 0),
      currentBalance: Number(openingBalance || 0),
      linkedEmployee: linkedEmployee ? linkedEmployee._id : null,
    });
    return sendSuccess(res, account, "Account created", 201);
  } catch (error) {
    console.error("Accounting create account error:", error);
    
    // Handle MongoDB duplicate key error
    if ((error as any).code === 11000) {
      const duplicateField = Object.keys((error as any).keyPattern || {})[0];
      if (duplicateField === 'code') {
        const requestedCode = `${(req as any).body?.code || ""}`.trim();
        return sendError(res, `Account code "${requestedCode}" already exists. Please use a different code.`, 409);
      }
      return sendError(res, `Duplicate ${duplicateField}: already exists`, 409);
    }
    
    // Handle validation errors
    if ((error as any).name === 'ValidationError') {
      const validationErrors = Object.values((error as any).errors || {})
        .map((err: any) => err.message)
        .join(', ');
      return sendError(res, `Validation failed: ${validationErrors}`, 400);
    }
    
    // Handle other known errors
    if ((error as Error).message) {
      return sendError(res, (error as Error).message, 500);
    }
    
    return sendError(res, "Failed to create account", 500);
  }
});

router.patch("/accounts/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const {
      code,
      title,
      type,
      subcategory,
      currency,
      supplierId,
      supplierName,
      paymentTerms,
      isReconcilable,
      metadata,
      address,
      contact,
      openingBalance,
      employeeId,
      linkedEmployeeId,
    } = req.body as Record<string, unknown>;
    if (!code || !title || !type) {
      return sendError(res, "Code, title, and account type are required", 400);
    }

    const account = await LedgerAccount.findById(String(id));
    if (!account) {
      return sendError(res, "Account not found", 404);
    }
    
    // Validate employee if provided
    const linkedEmpId = linkedEmployeeId || employeeId;
    let linkedEmployee = null;
    if (linkedEmpId) {
      const empIdStr = String(linkedEmpId).trim();
      if (mongoose.Types.ObjectId.isValid(empIdStr)) {
        linkedEmployee = await Employee.findById(empIdStr);
        if (!linkedEmployee) {
          return sendError(res, "Selected employee not found", 404);
        }
      }
    }

    const normalizedMetadata = sanitizeMetadata(metadata);
    const accountType = String(type).trim();
    const accountSubcategory = String(subcategory || "").trim();
    await assertSingleInventoryAccount(accountType, accountSubcategory, String(id));
    if (accountType === "asset" && accountSubcategory === "inventory") {
      const invalidMetadata = INVENTORY_METADATA_BLACKLIST.filter((key) => normalizedMetadata[key] !== undefined);
      if (invalidMetadata.length) {
        return sendError(res, `Inventory account cannot contain item-level metadata: ${invalidMetadata.join(", ")}`, 400);
      }
    }

    account.code = String(code).trim();
    account.title = String(title).trim();
    account.type = accountType;
    account.subcategory = accountSubcategory;
    account.currency = String(currency || "PKR").trim();
    account.supplierId = String(supplierId || "").trim();
    account.supplierName = String(
      supplierName || normalizedMetadata.supplierName || ""
    ).trim();
    account.paymentTerms = String(paymentTerms || "").trim();
    account.isReconcilable = Boolean(isReconcilable);
    account.metadata = normalizedMetadata;
    account.address = String(address || "").trim();
    account.contact = String(contact || "").trim();
    account.linkedEmployee = linkedEmployee ? linkedEmployee._id : null;

    const newOpeningBalance = Number(openingBalance || 0);
    if (!Number.isNaN(newOpeningBalance)) {
      if (account.currentBalance === account.openingBalance) {
        account.currentBalance = newOpeningBalance;
      }
      account.openingBalance = newOpeningBalance;
    }

    await account.save();
    return sendSuccess(res, account.toObject(), "Account updated");
  } catch (error) {
    console.error("Accounting update account error:", error);
    return sendError(res, "Failed to update account", 500);
  }
});

router.delete("/accounts/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const account = await LedgerAccount.findById(String(id));
    if (!account) {
      return sendError(res, "Account not found", 404);
    }
    account.isActive = false;
    await account.save();
    return sendSuccess(res, null, "Account deleted");
  } catch (error) {
    console.error("Accounting delete account error:", error);
    return sendError(res, "Failed to delete account", 500);
  }
});

router.get("/journal", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    const query: any = {};
    if (dateFrom) query.date = { $gte: new Date(dateFrom) };
    if (dateTo) query.date = { ...(query.date || {}), $lte: new Date(dateTo) };
    const entries = await JournalEntry.find(query).sort({ date: -1 }).lean();
    return sendSuccess(res, entries);
  } catch (error) {
    console.error("Accounting journal list error:", error);
    return sendError(res, "Failed to fetch journal entries", 500);
  }
});

router.post("/journal/backfill-pos", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();

    if (!(await isAdminOrManagerRoleName(req.user.role))) {
      return sendError(res, "Unauthorized", 403);
    }

    const { dateFrom, dateTo, dryRun = false, limit = 500 } = req.body as Record<string, unknown>;
    const parsedLimit = Math.min(Math.max(Number(limit) || 500, 1), 5000);

    const query: any = {};
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(String(dateFrom));
      if (dateTo) {
        const d = new Date(String(dateTo));
        d.setHours(23, 59, 59, 999);
        query.createdAt.$lte = d;
      }
    }

    const invoices = await Invoice.find(query)
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .select("_id invoiceNumber order paymentMethod subtotal taxAmount serviceChargeAmount total paymentAccountDiscountAmount createdAt issuedBy")
      .lean();

    let created = 0;
    let skipped = 0;
    let failed = 0;
    const failures: Array<{ invoiceId: string; invoiceNumber: string; reason: string }> = [];

    for (const invoice of invoices as any[]) {
      try {
        if (dryRun) {
          const order = invoice?.order ? await Order.findById(String(invoice.order)).select("_id").lean() : null;
          if (!order) {
            skipped += 1;
            continue;
          }
          const existing = await JournalEntry.findOne({ source: "POS", sourceId: order._id }).select("_id").lean();
          if (existing) {
            skipped += 1;
          } else {
            created += 1;
          }
          continue;
        }

        const result = await createMissingPosJournalForInvoice(invoice);
        if (result.created) {
          created += 1;
        } else {
          skipped += 1;
        }
      } catch (error: any) {
        failed += 1;
        failures.push({
          invoiceId: String(invoice._id || ""),
          invoiceNumber: String(invoice.invoiceNumber || ""),
          reason: error?.message || "Unknown error",
        });
      }
    }

    return sendSuccess(res, {
      totalScanned: invoices.length,
      created,
      skipped,
      failed,
      dryRun: Boolean(dryRun),
      failures,
    }, dryRun ? "Backfill dry run completed" : "POS journal backfill completed");
  } catch (error: any) {
    console.error("Accounting POS backfill error:", error);
    return sendError(res, error?.message || "Failed to backfill POS journals", 500);
  }
});

router.post("/journal", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const status = String(req.body.status || "posted");
    const payload = {
      ...req.body,
      source: req.body.source || "MANUAL",
      sourceId: req.body.sourceId || null,
      status,
      postedBy: status === "posted" ? req.user.id : null,
    };
    const entry = await createJournalEntryRecord(payload);
    return sendSuccess(res, entry, "Journal posted", 201);
  } catch (error: any) {
    console.error("Accounting create journal error:", error);
    const message = error?.message || "Failed to save journal entry";
    const status = message === "Journal entry already exists for this source" ? 409 : message.includes("required") ? 400 : 500;
    return sendError(res, message, status);
  }
});

router.get("/trial-balance", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    const accountQuery: any = { isActive: true };
    const journalMatch: any = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!Number.isNaN(from.getTime())) journalMatch.date = { ...journalMatch.date, $gte: from };
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        journalMatch.date = { ...journalMatch.date, $lte: to };
      }
    }

    const accounts = await LedgerAccount.find(accountQuery).sort({ code: 1 }).lean();
    const aggregationPipeline: any[] = [];
    if (Object.keys(journalMatch).length) {
      aggregationPipeline.push({ $match: journalMatch });
    }
    aggregationPipeline.push(
      { $unwind: "$lines" },
      {
        $group: {
          _id: "$lines.account",
          totalDebit: { $sum: "$lines.debit" },
          totalCredit: { $sum: "$lines.credit" },
        },
      },
      {
        $lookup: {
          from: LedgerAccount.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: "$account" },
      {
        $project: {
          accountId: { $toString: "$_id" },
          code: "$account.code",
          title: "$account.title",
          type: "$account.type",
          openingBalance: "$account.openingBalance",
          currentBalance: "$account.currentBalance",
          debitTotal: "$totalDebit",
          creditTotal: "$totalCredit",
        },
      }
    );

    const aggregatedRows = await JournalEntry.aggregate(aggregationPipeline);
    const totalsByAccount = new Map<string, { debit: number; credit: number }>();
    for (const row of aggregatedRows) {
      totalsByAccount.set(String(row.accountId), {
        debit: Number(row.debitTotal || 0),
        credit: Number(row.creditTotal || 0),
      });
    }

    const rows = accounts.map((account) => {
      const totals = totalsByAccount.get(String(account._id)) || { debit: 0, credit: 0 };
      return {
        accountId: String(account._id),
        code: account.code,
        title: account.title,
        type: account.type,
        openingBalance: Number(account.openingBalance || 0),
        currentBalance: Number(account.currentBalance || 0),
        debitTotal: totals.debit,
        creditTotal: totals.credit,
      };
    });

    const totalDebit = rows.reduce((sum, row) => sum + row.debitTotal, 0);
    const totalCredit = rows.reduce((sum, row) => sum + row.creditTotal, 0);

    return sendSuccess(res, { rows, totalDebit, totalCredit });
  } catch (error) {
    console.error("Accounting trial balance error:", error);
    return sendError(res, "Failed to fetch trial balance", 500);
  }
});

router.get("/balance-sheet", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    
    // Query ALL account types for complete balance sheet
    const accountQuery: any = {
      isActive: true,
      type: { $in: ["asset", "bank", "receivable", "liability", "equity"] },
    };

    const journalMatch: any = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!Number.isNaN(from.getTime())) journalMatch.date = { ...journalMatch.date, $gte: from };
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        journalMatch.date = { ...journalMatch.date, $lte: to };
      }
    }

    const accounts = await LedgerAccount.find(accountQuery).sort({ code: 1 }).lean();
    const accountIds = accounts.map((account) => account._id);

    const aggregationPipeline: any[] = [];
    if (Object.keys(journalMatch).length) {
      aggregationPipeline.push({ $match: journalMatch });
    }
    aggregationPipeline.push(
      { $unwind: "$lines" },
      { $match: { "lines.account": { $in: accountIds } } },
      {
        $group: {
          _id: "$lines.account",
          totalDebit: { $sum: "$lines.debit" },
          totalCredit: { $sum: "$lines.credit" },
        },
      },
      {
        $lookup: {
          from: LedgerAccount.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: "$account" },
      {
        $project: {
          accountId: { $toString: "$_id" },
          code: "$account.code",
          title: "$account.title",
          type: "$account.type",
          openingBalance: "$account.openingBalance",
          currentBalance: "$account.currentBalance",
          debitTotal: "$totalDebit",
          creditTotal: "$totalCredit",
        },
      }
    );

    const aggregatedRows = await JournalEntry.aggregate(aggregationPipeline);
    const totalsByAccount = new Map<string, { debit: number; credit: number }>();
    for (const row of aggregatedRows) {
      totalsByAccount.set(String(row.accountId), {
        debit: Number(row.debitTotal || 0),
        credit: Number(row.creditTotal || 0),
      });
    }

    // Calculate balance for each account
    const rows = accounts.map((account) => {
      const totals = totalsByAccount.get(String(account._id)) || { debit: 0, credit: 0 };
      // Assets increase with debits, Liabilities/Equity increase with credits
      const isAsset = ["asset", "bank", "receivable"].includes(account.type);
      const balance = isAsset
        ? Number(account.openingBalance || 0) + totals.debit - totals.credit
        : Number(account.openingBalance || 0) + totals.credit - totals.debit;
      
      return {
        accountId: String(account._id),
        code: account.code,
        title: account.title,
        type: account.type,
        openingBalance: Number(account.openingBalance || 0),
        debitTotal: totals.debit,
        creditTotal: totals.credit,
        balance,
      };
    });

    // Separate into sections
    const assets = rows.filter(r => ["asset", "bank", "receivable"].includes(r.type));
    const liabilities = rows.filter(r => r.type === "liability");
    const equity = rows.filter(r => r.type === "equity");

    // Calculate section totals
    const totalAssets = assets.reduce((sum, row) => sum + row.balance, 0);
    const totalLiabilities = liabilities.reduce((sum, row) => sum + row.balance, 0);
    const totalEquity = equity.reduce((sum, row) => sum + row.balance, 0);
    
    // Calculate Net Worth and verify accounting equation
    const netWorth = totalAssets - totalLiabilities;
    const liabilitiesAndEquity = totalLiabilities + totalEquity;
    const isBalanced = Math.abs(totalAssets - liabilitiesAndEquity) < 0.01; // Allow 1 paisa rounding

    return sendSuccess(res, {
      assets,
      liabilities,
      equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
      netWorth,
      liabilitiesAndEquity,
      isBalanced,
    });
  } catch (error) {
    console.error("Accounting balance sheet error:", error);
    return sendError(res, "Failed to fetch balance sheet", 500);
  }
});

/**
 * GET /api/accounting/profit-loss
 * Generate Profit & Loss Statement (Income Statement)
 * Shows: Revenue, COGS, Gross Profit, Operating Expenses, Net Profit/Loss
 */
router.get("/profit-loss", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { dateFrom, dateTo } = req.query as Record<string, string>;
    
    // Build date filter for journal entries
    const dateFilter: any = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo) dateFilter.$lte = new Date(dateTo);
    
    // Fetch all journal entries in the date range
    const journalQuery: any = { status: "posted" };
    if (Object.keys(dateFilter).length > 0) {
      journalQuery.date = dateFilter;
    }
    
    const entries = await JournalEntry.find(journalQuery).lean();
    
    // Aggregate by account
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
    
    // Fetch all accounts
    const accounts = await LedgerAccount.find({ isActive: true }).lean();
    const accountMap = new Map(accounts.map(a => [a._id.toString(), a]));
    
    // Categorize accounts and calculate balances
    const revenueAccounts: any[] = [];
    const cogsAccounts: any[] = [];
    const expenseAccounts: any[] = [];
    
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalExpenses = 0;
    
    for (const [accountId, totals] of accountTotals.entries()) {
      const account = accountMap.get(accountId);
      if (!account) continue;
      
      // Revenue accounts: Credit increases, Debit decreases
      // Balance = Credits - Debits (positive = revenue earned)
      if (account.type === "revenue") {
        const balance = totals.credit - totals.debit;
        if (balance !== 0) {
          revenueAccounts.push({
            accountId: account._id,
            code: account.code,
            title: account.title,
            subcategory: account.subcategory,
            debitTotal: totals.debit,
            creditTotal: totals.credit,
            balance,
          });
          totalRevenue += balance;
        }
      }
      
      // COGS accounts: Debit increases, Credit decreases
      // Balance = Debits - Credits (positive = cost incurred)
      else if (account.type === "expense" && account.subcategory === "cogs") {
        const balance = totals.debit - totals.credit;
        if (balance !== 0) {
          cogsAccounts.push({
            accountId: account._id,
            code: account.code,
            title: account.title,
            subcategory: account.subcategory,
            debitTotal: totals.debit,
            creditTotal: totals.credit,
            balance,
          });
          totalCOGS += balance;
        }
      }
      
      // Other expense accounts: Debit increases, Credit decreases
      // Balance = Debits - Credits (positive = expense incurred)
      else if (account.type === "expense" && account.subcategory !== "cogs") {
        const balance = totals.debit - totals.credit;
        if (balance !== 0) {
          expenseAccounts.push({
            accountId: account._id,
            code: account.code,
            title: account.title,
            subcategory: account.subcategory,
            debitTotal: totals.debit,
            creditTotal: totals.credit,
            balance,
          });
          totalExpenses += balance;
        }
      }
    }
    
    // Sort accounts by code
    revenueAccounts.sort((a, b) => a.code.localeCompare(b.code));
    cogsAccounts.sort((a, b) => a.code.localeCompare(b.code));
    expenseAccounts.sort((a, b) => a.code.localeCompare(b.code));
    
    // Calculate P&L metrics
    const grossProfit = totalRevenue - totalCOGS;
    const netProfit = grossProfit - totalExpenses;
    const grossProfitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const netProfitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    
    return sendSuccess(res, {
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      revenue: revenueAccounts,
      cogs: cogsAccounts,
      expenses: expenseAccounts,
      totalRevenue,
      totalCOGS,
      totalExpenses,
      grossProfit,
      netProfit,
      grossProfitMargin,
      netProfitMargin,
    });
  } catch (error) {
    console.error("Profit & Loss error:", error);
    return sendError(res, "Failed to generate Profit & Loss statement", 500);
  }
});

router.patch("/journal/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { date, reference, description, lines, source, sourceId, status } = req.body as Record<string, unknown>;
    if (!date || !Array.isArray(lines) || lines.length === 0) {
      return sendError(res, "Date and at least one journal line are required", 400);
    }

    const entry = await JournalEntry.findById(String(id));
    if (!entry) {
      return sendError(res, "Journal entry not found", 404);
    }

    const normalizedLines = normalizeJournalLines(lines as any[]);
    if (normalizedLines.length < 2) {
      return sendError(res, "At least two valid journal lines are required", 400);
    }

    const invalidLine = (lines as any[]).find((line) => {
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);
      return line.account && line.accountName && ((debit > 0 && credit > 0) || (debit === 0 && credit === 0));
    });
    if (invalidLine) {
      return sendError(res, "Each journal line must have exactly one nonzero amount on debit or credit", 400);
    }

    const { totalDebit, totalCredit, balanced } = validateJournalBalance(normalizedLines);
    if (!balanced) {
      return sendError(res, "Journal entry must balance debit and credit", 400);
    }

    const accountIds = normalizedLines.map((line) => String(line.account));
    const existingAccounts = await LedgerAccount.find({ _id: { $in: accountIds } }).lean();
    const accountMap = Object.fromEntries(existingAccounts.map((acct) => [String(acct._id), acct]));

    const invalidAccount = normalizedLines.find((line) => !accountMap[String(line.account)]);
    if (invalidAccount) {
      return sendError(res, `Ledger account not found for line: ${invalidAccount.accountName || String(invalidAccount.account)}` , 400);
    }

    if (source && source !== entry.source && sourceId) {
      const duplicate = await JournalEntry.findOne({ source, sourceId, _id: { $ne: entry._id } });
      if (duplicate) {
        return sendError(res, "Journal entry already exists for this source", 409);
      }
    }

    const preparedLines = normalizedLines.map((line) => ({
      account: line.account,
      accountName: accountMap[String(line.account)]?.title || line.accountName,
      debit: line.debit,
      credit: line.credit,
      note: line.note,
    }));

    entry.date = new Date(String(date));
    entry.reference = String(reference || "").trim();
    entry.description = String(description || "").trim();
    entry.lines = preparedLines;
    entry.totalDebit = totalDebit;
    entry.totalCredit = totalCredit;
    if (source) entry.source = String(source);
    if (sourceId) entry.sourceId = sourceId as any;
    if (status) {
      entry.status = String(status);
      if (entry.status === "posted" && !entry.postedBy) {
        entry.postedBy = req.user.id;
      }
    }

    await entry.save();
    return sendSuccess(res, entry.toObject(), "Journal entry updated");
  } catch (error) {
    console.error("Accounting update journal error:", error);
    return sendError(res, "Failed to update journal entry", 500);
  }
});

router.delete("/journal/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const entry = await JournalEntry.findById(String(id));
    if (!entry) {
      return sendError(res, "Journal entry not found", 404);
    }
    await entry.deleteOne();
    return sendSuccess(res, null, "Journal entry deleted");
  } catch (error) {
    console.error("Accounting delete journal error:", error);
    return sendError(res, "Failed to delete journal entry", 500);
  }
});

router.post("/journal/:id/reverse", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { id } = req.params;
    const entry = await JournalEntry.findById(String(id));
    if (!entry) {
      return sendError(res, "Journal entry not found", 404);
    }

    const reversed = await reverseJournalEntryRecord(entry, {
      ...req.body,
      postedBy: req.user.id,
      status: String(req.body.status || "posted"),
    });

    return sendSuccess(res, reversed, "Journal entry reversed", 201);
  } catch (error: any) {
    console.error("Accounting reverse journal error:", error);
    const message = error?.message || "Failed to reverse journal entry";
    const status = message === "Journal entry already exists for this source" ? 409 : message.includes("required") ? 400 : 500;
    return sendError(res, message, status);
  }
});

router.get("/returns", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { type, dateFrom, dateTo } = req.query as Record<string, string>;
    const query: any = {};
    if (type) query.returnType = type;
    if (dateFrom) query.date = { $gte: new Date(dateFrom) };
    if (dateTo) query.date = { ...(query.date || {}), $lte: new Date(dateTo) };
    const returns = await ReturnTransaction.find(query).sort({ date: -1 }).lean();
    return sendSuccess(res, returns);
  } catch (error) {
    console.error("Accounting returns list error:", error);
    return sendError(res, "Failed to fetch returns", 500);
  }
});

router.post("/returns", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { returnType, date, reference, relatedInvoice, purchaseId, customerName, supplierName, reason, items, totalAmount } = req.body as Record<string, unknown>;
    if (!returnType || !date || !Array.isArray(items) || items.length === 0) {
      return sendError(res, "Return type, date and returned items are required", 400);
    }
    let selectedPurchase: any = null;
    if (purchaseId) {
      const purchaseValue = String(purchaseId);
      if (!mongoose.Types.ObjectId.isValid(purchaseValue)) {
        return sendError(res, "Selected purchase invoice is invalid", 400);
      }
      selectedPurchase = await Purchase.findById(purchaseValue).lean();
      if (!selectedPurchase) {
        return sendError(res, "Selected purchase invoice was not found", 404);
      }
    }
    const normalizedItems = (items as any[])
      .map((item) => {
        const productId = String(item.productId || item.inventoryItemId || "").trim();
        const inventoryItemId = String(item.inventoryItemId || "").trim();
        return {
          productId: mongoose.Types.ObjectId.isValid(productId) ? productId : undefined,
          inventoryItemId: mongoose.Types.ObjectId.isValid(inventoryItemId) ? inventoryItemId : undefined,
          name: String(item.name || "").trim(),
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unitPrice || 0),
          subtotal: Number(item.subtotal || 0),
          condition: String(item.condition || "").trim(),
          note: String(item.note || "").trim(),
        };
      })
      .filter((item) => item.name && item.quantity > 0);
    if (!normalizedItems.length) {
      return sendError(res, "At least one valid returned item is required", 400);
    }
    const parsedTotalAmount = Number(totalAmount || 0);
    if (parsedTotalAmount <= 0) {
      return sendError(res, "Total return amount must be greater than zero", 400);
    }
    let accountId: string | null = null;
    let accountName = "";
    if (req.body?.account) {
      const accountValue = String(req.body.account);
      if (!mongoose.Types.ObjectId.isValid(accountValue)) {
        return sendError(res, "Selected ledger account is invalid", 400);
      }
      const account = await LedgerAccount.findById(accountValue).lean<any>();
      if (!account) {
        return sendError(res, "Selected ledger account was not found", 400);
      }
      accountId = String(account._id);
      accountName = account.title;
    }

    const status = String(
      req.body.status ||
        (String(returnType).trim().toLowerCase() === "sale" ? "processed" : "pending")
    ).trim();
    if (!["pending", "processed", "rejected"].includes(status)) {
      return sendError(res, "Invalid return status", 400);
    }

    const session = await mongoose.startSession();
    let returnRecord: any = null;
    try {
      await session.withTransaction(async () => {
        const [created] = await ReturnTransaction.create([
          {
            returnType: String(returnType).trim(),
            date: new Date(String(date)),
            reference: String(reference || "").trim(),
            purchaseId: selectedPurchase ? selectedPurchase._id : null,
            relatedInvoice: String(relatedInvoice || "").trim(),
            customerName: String(customerName || "").trim(),
            supplierName: String(supplierName || "").trim(),
            account: accountId,
            accountName,
            reason: String(reason || "").trim(),
            items: normalizedItems,
            totalAmount: Number(totalAmount || 0),
            createdBy: req.user.id,
            status,
            creditType: String(req.body.creditType || "credit_note").trim(),
          },
        ], { session });

        returnRecord = created.toObject();
        if (status === "processed") {
          try {
            await applyPurchaseReturnInventoryDeduction(returnRecord, session);
          } catch (inventoryError: any) {
            throw inventoryError;
          }
          try {
            await createReturnJournalEntry(returnRecord, session);
          } catch (journalError: any) {
            console.warn(
              "Accounting create return: journal entry skipped due to journal entry error",
              journalError
            );
          }
        }
      });
    } catch (error: any) {
      const msg = error?.message || String(error);
      const isTransactionUnavailable = /replica set|Transaction numbers/i.test(msg);
      if (isTransactionUnavailable) {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        try {
          const created = await ReturnTransaction.create({
            returnType: String(returnType).trim(),
            date: new Date(String(date)),
            reference: String(reference || "").trim(),
            purchaseId: selectedPurchase ? selectedPurchase._id : null,
            relatedInvoice: String(relatedInvoice || "").trim(),
            customerName: String(customerName || "").trim(),
            supplierName: String(supplierName || "").trim(),
            account: accountId,
            accountName,
            reason: String(reason || "").trim(),
            creditType: String(req.body.creditType || "credit_note").trim(),
            items: normalizedItems,
            totalAmount: Number(totalAmount || 0),
            createdBy: req.user.id,
            status,
          });
          returnRecord = created.toObject();
          if (status === "processed") {
            try {
              await applyPurchaseReturnInventoryDeduction(returnRecord, null);
            } catch (inventoryError: any) {
              console.error("Accounting create return fallback inventory deduction failed:", inventoryError);
              if (inventoryError instanceof InsufficientStockError) {
                return sendError(res, inventoryError.message, 409, { shortages: inventoryError.shortages });
              }
              return sendError(res, inventoryError?.message || "Failed to apply inventory deduction", 500);
            }
            try {
              await createReturnJournalEntry(returnRecord);
            } catch (innerError: any) {
              console.warn(
                "Accounting create return fallback: journal entry skipped due to journal entry error",
                innerError
              );
            }
          }
        } catch (innerError: any) {
          console.error("Accounting create return fallback error:", innerError);
          return sendError(res, innerError?.message || "Failed to save return", 500);
        }
      } else {
        console.error("Accounting create return error:", error);
        return sendError(res, msg || "Failed to save return", 500);
      }
    } finally {
      session.endSession();
    }

    return sendSuccess(res, returnRecord, "Return recorded", 201);
  } catch (error: any) {
    console.error("Accounting create return error:", error);
    return sendError(res, error?.message || "Failed to save return", 500);
  }
});

router.patch("/returns/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const returnId = String(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(returnId)) {
      return sendError(res, "Invalid return id", 400);
    }

    const returnDoc = await ReturnTransaction.findById(returnId);
    if (!returnDoc) {
      return sendError(res, "Return not found", 404);
    }

    const { status, account, creditType, supplierName, reason, reference, relatedInvoice } = req.body as Record<string, unknown>;
    const nextStatus = String(status || returnDoc.status).trim();
    if (!["pending", "processed", "rejected"].includes(nextStatus)) {
      return sendError(res, "Invalid return status", 400);
    }

    if (account) {
      const accountValue = String(account);
      if (!mongoose.Types.ObjectId.isValid(accountValue)) {
        return sendError(res, "Selected ledger account is invalid", 400);
      }
      const accountRecord = await LedgerAccount.findById(accountValue).lean<any>();
      if (!accountRecord) {
        return sendError(res, "Selected ledger account was not found", 400);
      }
      returnDoc.account = accountValue;
      returnDoc.accountName = accountRecord.title;
    }

    if (supplierName !== undefined) {
      returnDoc.supplierName = String(supplierName || "").trim();
    }
    if (reason !== undefined) {
      returnDoc.reason = String(reason || "").trim();
    }
    if (reference !== undefined) {
      returnDoc.reference = String(reference || "").trim();
    }
    if (relatedInvoice !== undefined) {
      returnDoc.relatedInvoice = String(relatedInvoice || "").trim();
    }
    if (creditType !== undefined) {
      returnDoc.creditType = String(creditType || "credit_note").trim();
    }

    if (returnDoc.status !== "processed" && nextStatus === "processed") {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await applyPurchaseReturnInventoryDeduction(returnDoc.toObject(), session);
          try {
            await createReturnJournalEntry(returnDoc.toObject(), session);
          } catch (journalError: any) {
            console.warn(
              "Accounting approve return: journal entry skipped due to journal error",
              journalError
            );
          }
          returnDoc.status = nextStatus;
          await returnDoc.save({ session });
        });
      } catch (approvalError: any) {
        const message = approvalError?.message || String(approvalError);
        const isTransactionUnavailable = /replica set|Transaction numbers/i.test(message);
        if (isTransactionUnavailable) {
          if (session.inTransaction()) {
            await session.abortTransaction();
          }
          try {
            await applyPurchaseReturnInventoryDeduction(returnDoc.toObject(), null);
          } catch (inventoryError: any) {
            console.error("Accounting approve return fallback inventory deduction failed:", inventoryError);
            if (inventoryError instanceof InsufficientStockError) {
              return sendError(res, inventoryError.message, 409, { shortages: inventoryError.shortages });
            }
            return sendError(res, inventoryError?.message || "Failed to approve return", 500);
          }
          try {
            await createReturnJournalEntry(returnDoc.toObject());
          } catch (journalError: any) {
            console.warn(
              "Accounting approve return fallback: journal entry skipped due to journal error",
              journalError
            );
          }
          returnDoc.status = nextStatus;
          await returnDoc.save();
        } else {
          console.error("Accounting approve return failed to process inventory and journal entry:", approvalError);
          if (approvalError instanceof InsufficientStockError) {
            return sendError(res, approvalError.message, 409, { shortages: approvalError.shortages });
          }
          return sendError(res, approvalError?.message || "Failed to approve return", 500);
        }
      } finally {
        session.endSession();
      }
    } else {
      returnDoc.status = nextStatus;
      await returnDoc.save();
    }

    return sendSuccess(res, returnDoc.toObject(), "Return updated");
  } catch (error: any) {
    console.error("Accounting update return error:", error);
    return sendError(res, error?.message || "Failed to update return", 500);
  }
});

export default router;
