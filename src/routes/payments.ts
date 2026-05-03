import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Payment from "../models/Payment";
import Supplier from "../models/Supplier";
import Customer from "../models/Customer";
import LedgerAccount from "../models/LedgerAccount";
import Purchase from "../models/Purchase";
import JournalEntry from "../models/JournalEntry";
import { createJournalEntryRecord } from "../lib/journalPosting";
import { resolveExpensePaymentAccount } from "../lib/journalPosting";
import { logAuditTrail } from "../lib/auditLog";
import mongoose from "mongoose";

const router: Router = Router();

/**
 * POST /api/payments/supplier
 * Record a payment to a supplier (reduces A/P liability)
 */
router.post("/supplier", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { supplierId, amount, paymentDate, paymentMethod, referenceNumber, notes, purchaseId } = req.body;
    
    // Validation
    if (!supplierId || !mongoose.Types.ObjectId.isValid(supplierId)) {
      return sendError(res, "Valid supplier ID is required", 400);
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return sendError(res, "Valid payment amount is required", 400);
    }
    
    // Verify supplier exists
    const supplier = await Supplier.findById(supplierId).populate("ledgerAccountId");
    if (!supplier) {
      return sendError(res, "Supplier not found", 404);
    }
    
    // Get supplier's A/P account (or default A/P)
    let supplierApAccount = null;
    if (supplier.ledgerAccountId) {
      supplierApAccount = await LedgerAccount.findById(supplier.ledgerAccountId);
    }
    
    if (!supplierApAccount) {
      // Fallback to default A/P account
      supplierApAccount = await LedgerAccount.findOne({
        type: "liability",
        subcategory: "accounts-payable",
      }).sort({ code: 1 });
    }
    
    if (!supplierApAccount) {
      return sendError(res, "No accounts payable account found. Create A/P accounts first.", 400);
    }
    
    // Get payment account (cash/bank based on payment method)
    const paymentAccount = await resolveExpensePaymentAccount(paymentMethod || "cash");
    if (!paymentAccount) {
      return sendError(res, "No payment account found for the selected payment method", 400);
    }
    
    const recordedBy = (req.user as any)._id || req.user.id;

    // Create payment record
    const payment = await Payment.create({
      type: "supplier",
      supplierId,
      amount: Number(amount),
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      paymentMethod: paymentMethod || "cash",
      referenceNumber: referenceNumber || "",
      notes: notes || "",
      purchaseId: purchaseId || null,
      recordedBy,
      status: "posted",
    });
    
    // Post journal entry: Debit A/P (reduces liability), Credit Cash/Bank (reduces asset)
    try {
      const journalEntry = await createJournalEntryRecord({
        date: payment.paymentDate,
        reference: payment.referenceNumber || `PAY-${payment._id}`,
        description: `Payment to ${supplier.name}${purchaseId ? ` for purchase ${purchaseId}` : ""}`,
        lines: [
          {
            account: supplierApAccount._id,
            accountName: supplierApAccount.title,
            debit: Number(amount),
            credit: 0,
            note: `Payment to ${supplier.name}`,
          },
          {
            account: paymentAccount._id,
            accountName: paymentAccount.title,
            debit: 0,
            credit: Number(amount),
            note: `Payment to ${supplier.name}`,
          },
        ],
        source: "PAYMENT",
        sourceId: payment._id,
        postedBy: recordedBy,
      });
      
      // Link journal entry to payment
      payment.journalEntryId = journalEntry._id as any;
      await payment.save();
      
      // Update Purchase paidAmount if linked to specific purchase
      if (purchaseId && mongoose.Types.ObjectId.isValid(purchaseId)) {
        try {
          const purchase = await Purchase.findById(purchaseId);
          if (purchase) {
            purchase.paidAmount = (purchase.paidAmount || 0) + Number(amount);
            await purchase.save(); // paymentStatus will auto-update via pre-save hook
            console.log(`✅ Updated purchase ${purchase.referenceNumber || purchaseId} - Paid: Rs ${purchase.paidAmount}`);
          }
        } catch (purchaseUpdateError) {
          console.error("⚠️ Failed to update purchase paidAmount:", purchaseUpdateError);
          // Don't fail the payment - just log the error
        }
      }
      
      console.log(`✅ Posted supplier payment: ${supplier.name} - Rs ${amount}`);
      
      // Audit log
      await logAuditTrail({
        userId: req.user._id,
        action: "CREATE_SUPPLIER_PAYMENT",
        module: "payments",
        description: `Recorded payment to supplier ${supplier.name} - Rs ${amount}`,
        metadata: { paymentId: payment._id, supplierId, amount, paymentMethod, purchaseId },
      });
    } catch (journalError: any) {
      console.error("⚠️ Failed to post payment journal entry:", journalError);
      // Payment record still exists, but journal entry failed
      return sendError(res, `Payment recorded but journal posting failed: ${journalError.message}`, 500);
    }
    
    return sendSuccess(res, payment, "Supplier payment recorded successfully", 201);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error recording supplier payment:", error);
    return sendError(res, message || "Failed to record supplier payment", 500, {
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
});

/**
 * POST /api/payments/customer
 * Record a payment from a customer (reduces A/R asset or increases cash for cash sales)
 */
router.post("/customer", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { customerId, amount, paymentDate, paymentMethod, referenceNumber, notes, invoiceId } = req.body;
    
    // Validation
    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      return sendError(res, "Valid customer ID is required", 400);
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return sendError(res, "Valid payment amount is required", 400);
    }
    
    // Verify customer exists
    const customer = await Customer.findById(customerId).populate("ledgerAccountId");
    if (!customer) {
      return sendError(res, "Customer not found", 404);
    }
    
    // Get customer's A/R account (or default A/R)
    let customerArAccount = null;
    if (customer.ledgerAccountId) {
      customerArAccount = await LedgerAccount.findById(customer.ledgerAccountId);
    }
    
    if (!customerArAccount) {
      // Fallback to default A/R account
      customerArAccount = await LedgerAccount.findOne({
        type: "receivable",
        subcategory: "accounts-receivable",
      }).sort({ code: 1 });
    }
    
    if (!customerArAccount) {
      return sendError(res, "No accounts receivable account found. Create A/R accounts first.", 400);
    }
    
    // Get payment account (cash/bank based on payment method)
    const paymentAccount = await resolveExpensePaymentAccount(paymentMethod || "cash");
    if (!paymentAccount) {
      return sendError(res, "No payment account found for the selected payment method", 400);
    }
    
    const recordedBy = (req.user as any)._id || req.user.id;

    // Create payment record
    const payment = await Payment.create({
      type: "customer",
      customerId,
      amount: Number(amount),
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      paymentMethod: paymentMethod || "cash",
      referenceNumber: referenceNumber || "",
      notes: notes || "",
      invoiceId: invoiceId || null,
      recordedBy,
      status: "posted",
    });
    
    // Post journal entry: Debit Cash/Bank (increases asset), Credit A/R (reduces asset)
    try {
      const journalEntry = await createJournalEntryRecord({
        date: payment.paymentDate,
        reference: payment.referenceNumber || `REC-${payment._id}`,
        description: `Payment from ${customer.name}${invoiceId ? ` for invoice ${invoiceId}` : ""}`,
        lines: [
          {
            account: paymentAccount._id,
            accountName: paymentAccount.title,
            debit: Number(amount),
            credit: 0,
            note: `Payment from ${customer.name}`,
          },
          {
            account: customerArAccount._id,
            accountName: customerArAccount.title,
            debit: 0,
            credit: Number(amount),
            note: `Payment from ${customer.name}`,
          },
        ],
        source: "PAYMENT",
        sourceId: payment._id,
        postedBy: recordedBy,
      });
      
      // Link journal entry to payment
      payment.journalEntryId = journalEntry._id as any;
      await payment.save();
      
      // Update Invoice paidAmount if linked to specific invoice (when Invoice model is implemented)
      if (invoiceId && mongoose.Types.ObjectId.isValid(invoiceId)) {
        try {
          // Placeholder: Uncomment when Invoice model exists
          // const invoice = await Invoice.findById(invoiceId);
          // if (invoice) {
          //   invoice.paidAmount = (invoice.paidAmount || 0) + Number(amount);
          //   await invoice.save(); // paymentStatus will auto-update via pre-save hook
          //   console.log(`✅ Updated invoice ${invoice.invoiceNumber || invoiceId} - Paid: Rs ${invoice.paidAmount}`);
          // }
          console.log(`⚠️ Invoice update skipped - Invoice model not yet implemented`);
        } catch (invoiceUpdateError) {
          console.error("⚠️ Failed to update invoice paidAmount:", invoiceUpdateError);
        }
      }
      
      console.log(`✅ Posted customer payment: ${customer.name} - Rs ${amount}`);
      
      // Audit log
      await logAuditTrail({
        userId: req.user._id,
        action: "CREATE_CUSTOMER_PAYMENT",
        module: "payments",
        description: `Recorded payment from customer ${customer.name} - Rs ${amount}`,
        metadata: { paymentId: payment._id, customerId, amount, paymentMethod, invoiceId },
      });
    } catch (journalError: any) {
      console.error("⚠️ Failed to post payment journal entry:", journalError);
      return sendError(res, `Payment recorded but journal posting failed: ${journalError.message}`, 500);
    }
    
    return sendSuccess(res, payment, "Customer payment recorded successfully", 201);
  } catch (error) {
    console.error("Error recording customer payment:", error);
    return sendError(res, "Failed to record customer payment", 500);
  }
});

/**
 * GET /api/payments
 * List all payments with filters
 */
router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { type, supplierId, customerId, from, to, page = "1", limit = "50" } = req.query as Record<string, string>;
    
    const query: any = { status: "posted" };
    
    if (type === "supplier" || type === "customer") {
      query.type = type;
    }
    if (supplierId && mongoose.Types.ObjectId.isValid(supplierId)) {
      query.supplierId = supplierId;
    }
    if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
      query.customerId = customerId;
    }
    if (from || to) {
      query.paymentDate = {};
      if (from) query.paymentDate.$gte = new Date(from);
      if (to) query.paymentDate.$lte = new Date(to);
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
    const total = await Payment.countDocuments(query);
    const payments = await Payment.find(query)
      .populate("supplierId", "name")
      .populate("customerId", "name")
      .populate("recordedBy", "name")
      .sort({ paymentDate: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();
    
    return sendSuccess(res, { payments, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("Error fetching payments:", error);
    return sendError(res, "Failed to fetch payments", 500);
  }
});

/**
 * GET /api/payments/:id
 * Get single payment details
 */
router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const payment = await Payment.findById(req.params.id)
      .populate("supplierId")
      .populate("customerId")
      .populate("recordedBy", "name")
      .populate("journalEntryId");
    
    if (!payment) {
      return sendError(res, "Payment not found", 404);
    }
    
    return sendSuccess(res, payment);
  } catch (error) {
    console.error("Error fetching payment:", error);
    return sendError(res, "Failed to fetch payment", 500);
  }
});

/**
 * GET /api/payments/outstanding/:type/:entityId
 * Get outstanding balance for a supplier or customer from their ledger account
 */
router.get("/outstanding/:type/:entityId", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { type, entityId } = req.params;
    
    if (!["supplier", "customer"].includes(type)) {
      return sendError(res, "Type must be 'supplier' or 'customer'", 400);
    }
    
    if (!mongoose.Types.ObjectId.isValid(entityId)) {
      return sendError(res, "Invalid entity ID", 400);
    }
    
    let ledgerAccount = null;
    let entityName = "";
    
    if (type === "supplier") {
      const supplier = await Supplier.findById(entityId).populate("ledgerAccountId");
      if (!supplier) {
        return sendError(res, "Supplier not found", 404);
      }
      entityName = supplier.name;
      ledgerAccount = supplier.ledgerAccountId || null;
    } else {
      const customer = await Customer.findById(entityId).populate("ledgerAccountId");
      if (!customer) {
        return sendError(res, "Customer not found", 404);
      }
      entityName = customer.name;
      ledgerAccount = customer.ledgerAccountId || null;
    }
    
    if (!ledgerAccount) {
      return sendSuccess(res, { balance: 0, entityName, hasLedgerAccount: false });
    }
    
    // Calculate balance from journal entries
    const entries = await JournalEntry.aggregate([
      { $match: { status: "posted" } },
      { $unwind: "$lines" },
      { $match: { "lines.account": new mongoose.Types.ObjectId(ledgerAccount._id) } },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: "$lines.debit" },
          totalCredit: { $sum: "$lines.credit" },
        },
      },
    ]);
    
    const totalDebit = entries.length > 0 ? entries[0].totalDebit : 0;
    const totalCredit = entries.length > 0 ? entries[0].totalCredit : 0;
    
    // For suppliers (A/P - liability): Credit balance means we owe them
    // For customers (A/R - asset): Debit balance means they owe us
    const balance = type === "supplier" 
      ? totalCredit - totalDebit  // Positive = we owe supplier
      : totalDebit - totalCredit; // Positive = customer owes us
    
    return sendSuccess(res, {
      balance: Math.max(0, balance), // Don't show negative balances
      totalDebit,
      totalCredit,
      entityName,
      ledgerAccountId: ledgerAccount._id,
      ledgerAccountTitle: ledgerAccount.title,
      hasLedgerAccount: true,
    });
  } catch (error) {
    console.error("Error fetching outstanding balance:", error);
    return sendError(res, "Failed to fetch outstanding balance", 500);
  }
});

/**
 * GET /api/payments/pending-purchases/:supplierId
 * Get list of unpaid and partially paid purchases for a supplier
 */
router.get("/pending-purchases/:supplierId", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { supplierId } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      return sendError(res, "Invalid supplier ID", 400);
    }
    
    const purchases = await Purchase.find({
      supplier: supplierId,
      status: "posted",
      paymentStatus: { $in: ["unpaid", "partial"] },
    })
      .select("referenceNumber receivedAt totalAmount paidAmount paymentStatus")
      .sort({ receivedAt: -1 })
      .lean();
    
    // Calculate remaining amount for each purchase
    const pendingPurchases = purchases.map((p: any) => ({
      _id: p._id,
      referenceNumber: p.referenceNumber || p._id.toString(),
      receivedAt: p.receivedAt,
      totalAmount: p.totalAmount,
      paidAmount: p.paidAmount || 0,
      remainingAmount: p.totalAmount - (p.paidAmount || 0),
      paymentStatus: p.paymentStatus,
    }));
    
    return sendSuccess(res, pendingPurchases);
  } catch (error) {
    console.error("Error fetching pending purchases:", error);
    return sendError(res, "Failed to fetch pending purchases", 500);
  }
});

/**
 * GET /api/payments/pending-invoices/:customerId
 * Get list of unpaid and partially paid invoices for a customer
 * Note: Placeholder for when Invoice model is implemented
 */
router.get("/pending-invoices/:customerId", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    
    const { customerId } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return sendError(res, "Invalid customer ID", 400);
    }
    
    // Placeholder: Return empty array until Invoice model is implemented
    // When ready, query: Invoice.find({ customer: customerId, paymentStatus: { $in: ['unpaid', 'partial'] } })
    
    return sendSuccess(res, []);
  } catch (error) {
    console.error("Error fetching pending invoices:", error);
    return sendError(res, "Failed to fetch pending invoices", 500);
  }
});

export default router;
