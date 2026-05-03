import "../src/lib/env"; // Load environment variables first
import mongoose from "mongoose";
import { connectDB } from "../src/lib/mongodb";
import Supplier from "../src/models/Supplier";
import Customer from "../src/models/Customer";
import LedgerAccount from "../src/models/LedgerAccount";

/**
 * Migration Script: Link Existing Suppliers/Customers to Ledger Accounts
 * 
 * This script:
 * 1. Finds all suppliers without linked ledger accounts
 * 2. Creates A/P accounts for them (GL codes 2100-2999)
 * 3. Finds all customers without linked ledger accounts
 * 4. Creates A/R accounts for them (GL codes 1300-1399)
 * 5. Links the accounts to the respective entities
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

async function getNextCustomerAccountCode(): Promise<string> {
  const start = 1300;
  const end = 1399;
  
  const existingAccounts = await LedgerAccount.find({
    code: { $gte: String(start), $lte: String(end) },
  }).sort({ code: 1 }).lean();
  
  const usedCodes = new Set(existingAccounts.map(a => parseInt(a.code)));
  
  for (let code = start; code <= end; code++) {
    if (!usedCodes.has(code)) {
      return String(code);
    }
  }
  
  throw new Error("No available GL codes in range 1300-1399 for customer accounts");
}

async function migrateSuppliersToLedgerAccounts() {
  console.log("\n📊 Migrating Suppliers to Ledger Accounts...");
  
  // Find suppliers without linked ledger accounts
  const suppliersWithoutAccounts = await Supplier.find({
    $or: [
      { ledgerAccountId: null },
      { ledgerAccountId: { $exists: false } },
    ],
    isActive: true,
  });
  
  console.log(`Found ${suppliersWithoutAccounts.length} suppliers without ledger accounts`);
  
  if (suppliersWithoutAccounts.length === 0) {
    console.log("✅ All suppliers already have ledger accounts");
    return 0;
  }
  
  let created = 0;
  
  for (const supplier of suppliersWithoutAccounts) {
    try {
      const code = await getNextSupplierAccountCode();
      
      const ledgerAccount = await LedgerAccount.create({
        code,
        title: `A/P - ${supplier.name}`,
        type: "liability",
        subcategory: "accounts-payable",
        currency: "PKR",
        supplierId: supplier._id.toString(),
        supplierName: supplier.name,
        paymentTerms: supplier.paymentTerms || "30",
        address: supplier.address || "",
        contact: supplier.phone || "",
        openingBalance: 0,
        currentBalance: 0,
        isActive: true,
        metadata: {
          autoCreated: true,
          migratedAt: new Date(),
          linkedEntity: "supplier",
          linkedEntityId: supplier._id.toString(),
        },
      });
      
      // Link ledger account to supplier
      supplier.ledgerAccountId = ledgerAccount._id as any;
      await supplier.save();
      
      created++;
      console.log(`  ✅ Created A/P account (${code}) for supplier: ${supplier.name}`);
    } catch (error) {
      console.error(`  ❌ Failed to create account for supplier ${supplier.name}:`, error);
    }
  }
  
  console.log(`✅ Created ${created} supplier A/P accounts`);
  return created;
}

async function migrateCustomersToLedgerAccounts() {
  console.log("\n📊 Migrating Customers to Ledger Accounts...");
  
  // Find customers without linked ledger accounts
  const customersWithoutAccounts = await Customer.find({
    $or: [
      { ledgerAccountId: null },
      { ledgerAccountId: { $exists: false } },
    ],
    isActive: true,
  });
  
  console.log(`Found ${customersWithoutAccounts.length} customers without ledger accounts`);
  
  if (customersWithoutAccounts.length === 0) {
    console.log("✅ All customers already have ledger accounts");
    return 0;
  }
  
  let created = 0;
  
  for (const customer of customersWithoutAccounts) {
    try {
      const code = await getNextCustomerAccountCode();
      
      const ledgerAccount = await LedgerAccount.create({
        code,
        title: `A/R - ${customer.name}`,
        type: "receivable",
        subcategory: "accounts-receivable",
        currency: "PKR",
        address: customer.address || "",
        contact: customer.phone || "",
        openingBalance: 0,
        currentBalance: 0,
        isActive: true,
        metadata: {
          autoCreated: true,
          migratedAt: new Date(),
          linkedEntity: "customer",
          linkedEntityId: customer._id.toString(),
          email: customer.email || "",
        },
      });
      
      // Link ledger account to customer
      customer.ledgerAccountId = ledgerAccount._id as any;
      await customer.save();
      
      created++;
      console.log(`  ✅ Created A/R account (${code}) for customer: ${customer.name}`);
    } catch (error) {
      console.error(`  ❌ Failed to create account for customer ${customer.name}:`, error);
    }
  }
  
  console.log(`✅ Created ${created} customer A/R accounts`);
  return created;
}

async function runMigration() {
  try {
    await connectDB();
    console.log("🔗 Connected to MongoDB");
    console.log("🚀 Starting migration: Link Suppliers/Customers to Ledger Accounts");
    console.log("=" .repeat(70));
    
    const suppliersCreated = await migrateSuppliersToLedgerAccounts();
    const customersCreated = await migrateCustomersToLedgerAccounts();
    
    console.log("\n" + "=".repeat(70));
    console.log("✅ Migration Complete!");
    console.log(`   - Supplier A/P accounts created: ${suppliersCreated}`);
    console.log(`   - Customer A/R accounts created: ${customersCreated}`);
    console.log(`   - Total accounts created: ${suppliersCreated + customersCreated}`);
    
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  }
}

// Run the migration
runMigration();
