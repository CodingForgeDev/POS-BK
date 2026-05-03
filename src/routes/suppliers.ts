import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Supplier from "../models/Supplier";
import LedgerAccount from "../models/LedgerAccount";
import mongoose from "mongoose";

const router: Router = Router();

/**
 * Get next available GL code in the 2000-2999 range for supplier A/P accounts
 */
async function getNextSupplierAccountCode(): Promise<string> {
  const start = 2100;
  const end = 2999;
  
  const existingAccounts = await LedgerAccount.find({
    code: { $gte: String(start), $lte: String(end) },
  }).sort({ code: 1 }).lean();
  
  const usedCodes = new Set(existingAccounts.map(a => parseInt(a.code)));
  
  for (let code = start; code <= end; code++) {
    if (!usedCodes.has(code)) {
      return String(code);
    }
  }
  
  throw new Error("No available GL codes in range 2100-2999 for supplier accounts");
}

/**
 * Create or update ledger account for supplier
 */
async function upsertSupplierLedgerAccount(
  supplierId: string,
  supplierName: string,
  paymentTerms: string,
  address: string,
  phone: string,
  existingLedgerAccountId?: string | null
): Promise<string> {
  if (existingLedgerAccountId && mongoose.Types.ObjectId.isValid(existingLedgerAccountId)) {
    // Update existing ledger account
    const updated = await LedgerAccount.findByIdAndUpdate(
      existingLedgerAccountId,
      {
        title: `A/P - ${supplierName}`,
        supplierName,
        paymentTerms: paymentTerms || "30",
        address: address || "",
        contact: phone || "",
      },
      { new: true }
    );
    if (updated) return updated._id.toString();
  }
  
  // Create new ledger account
  const code = await getNextSupplierAccountCode();
  const ledgerAccount = await LedgerAccount.create({
    code,
    title: `A/P - ${supplierName}`,
    type: "liability",
    subcategory: "accounts-payable",
    currency: "PKR",
    supplierId,
    supplierName,
    paymentTerms: paymentTerms || "30",
    address: address || "",
    contact: phone || "",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      autoCreated: true,
      linkedEntity: "supplier",
      linkedEntityId: supplierId,
    },
  });
  
  return ledgerAccount._id.toString();
}

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const { search } = req.query as Record<string, string>;

    const query: any = { isActive: true };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { contactPerson: { $regex: search, $options: "i" } },
        { supplyCategory: { $regex: search, $options: "i" } },
      ];
    }

    const suppliers = await Supplier.find(query).sort({ name: 1 }).lean();
    return sendSuccess(res, suppliers);
  } catch (error) {
    return sendError(res, "Failed to fetch suppliers", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    
    // Create supplier first
    const supplier = await Supplier.create(req.body);
    
    // Auto-create A/P ledger account for supplier
    try {
      const ledgerAccountId = await upsertSupplierLedgerAccount(
        supplier._id.toString(),
        supplier.name,
        supplier.paymentTerms || "",
        supplier.address || "",
        supplier.phone || ""
      );
      
      // Link ledger account to supplier
      supplier.ledgerAccountId = new mongoose.Types.ObjectId(ledgerAccountId) as any;
      await supplier.save();
      
      console.log(`✅ Auto-created A/P account for supplier: ${supplier.name} (GL ${ledgerAccountId})`);
    } catch (ledgerError) {
      console.error("⚠️  Failed to create supplier ledger account:", ledgerError);
      // Continue without failing - supplier is still created
    }
    
    return sendSuccess(res, supplier, "Supplier created", 201);
  } catch (error) {
    return sendError(res, "Failed to create supplier", 500);
  }
});

router.get("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return sendError(res, "Supplier not found", 404);
    return sendSuccess(res, supplier);
  } catch (error) {
    return sendError(res, "Failed to fetch supplier", 500);
  }
});

router.patch("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }
    
    const existing = await Supplier.findById(req.params.id);
    if (!existing) return sendError(res, "Supplier not found", 404);
    
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!supplier) return sendError(res, "Supplier not found", 404);
    
    // Update linked ledger account if name or details changed
    if (supplier.ledgerAccountId) {
      try {
        await upsertSupplierLedgerAccount(
          supplier._id.toString(),
          supplier.name,
          supplier.paymentTerms || "",
          supplier.address || "",
          supplier.phone || "",
          supplier.ledgerAccountId.toString()
        );
      } catch (ledgerError) {
        console.error("⚠️  Failed to update supplier ledger account:", ledgerError);
      }
    }
    
    return sendSuccess(res, supplier, "Supplier updated");
  } catch (error) {
    return sendError(res, "Failed to update supplier", 500);
  }
});

router.delete("/:id", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (req.user.role !== "admin") return sendError(res, "Unauthorized", 403);
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!supplier) return sendError(res, "Supplier not found", 404);
    return sendSuccess(res, null, "Supplier removed");
  } catch (error) {
    return sendError(res, "Failed to remove supplier", 500);
  }
});

export default router;
