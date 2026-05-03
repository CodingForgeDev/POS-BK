import "../src/lib/env"; // Load environment variables first
import mongoose from "mongoose";
import LedgerAccount from "../src/models/LedgerAccount";
import Setting from "../src/models/Setting";
import { connectDB } from "../src/lib/mongodb";

/**
 * Default Chart of Accounts for POS Cafe
 * This script seeds the database with a standard set of accounting accounts
 * following professional accounting principles for a Point of Sale system.
 * 
 * GL Code Ranges:
 * 1000-1999: Assets (Cash, Bank, Inventory, Receivables)
 * 2000-2999: Liabilities (Payables, Loans, Tax Payable)
 * 3000-3999: Equity (Capital, Retained Earnings, Drawings)
 * 4000-4999: Revenue (Sales, Service Income)
 * 5000-5999: Cost of Goods Sold
 * 6000-9999: Operating Expenses
 */

const DEFAULT_ACCOUNTS = [
  // ─── ASSETS (1000-1999) ───────────────────────────────────────────────────
  {
    code: "1000",
    title: "Cash on Hand",
    type: "bank",
    subcategory: "cash",
    currency: "PKR",
    isReconcilable: true,
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Physical cash in cash drawer",
      isDefault: true,
      accountPurpose: "cash-drawer",
    },
  },
  {
    code: "1010",
    title: "Petty Cash",
    type: "bank",
    subcategory: "cash",
    currency: "PKR",
    isReconcilable: true,
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Small cash for minor expenses",
      accountPurpose: "petty-cash",
    },
  },
  {
    code: "1100",
    title: "Bank Account - Main",
    type: "bank",
    subcategory: "checking",
    currency: "PKR",
    isReconcilable: true,
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Primary business bank account",
      isDefault: true,
      accountPurpose: "main-bank",
    },
  },
  {
    code: "1200",
    title: "Inventory",
    type: "asset",
    subcategory: "inventory",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Cost of inventory on hand",
      isDefault: true,
      accountPurpose: "inventory-asset",
    },
  },
  {
    code: "1300",
    title: "Accounts Receivable",
    type: "receivable",
    subcategory: "accounts-receivable",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Money owed by customers (default A/R account)",
      isDefault: true,
      accountPurpose: "default-ar",
    },
  },
  {
    code: "1400",
    title: "Equipment",
    type: "asset",
    subcategory: "fixed-assets",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Kitchen equipment, furniture, fixtures",
      accountPurpose: "fixed-assets",
    },
  },

  // ─── LIABILITIES (2000-2999) ───────────────────────────────────────────────
  {
    code: "2000",
    title: "Accounts Payable",
    type: "liability",
    subcategory: "accounts-payable",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Money owed to suppliers (default A/P account)",
      isDefault: true,
      accountPurpose: "default-ap",
    },
  },
  {
    code: "2100",
    title: "GST/Sales Tax Payable",
    type: "liability",
    subcategory: "tax-payable",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Sales tax collected from customers",
      isDefault: true,
      accountPurpose: "tax-payable",
    },
  },
  {
    code: "2200",
    title: "Service Charge Payable",
    type: "liability",
    subcategory: "other",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Service charges collected to be distributed",
      isDefault: true,
      accountPurpose: "service-charge-payable",
    },
  },
  {
    code: "2300",
    title: "Salaries Payable",
    type: "liability",
    subcategory: "payroll",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Accrued salaries and wages",
      accountPurpose: "salaries-payable",
    },
  },

  // ─── EQUITY (3000-3999) ────────────────────────────────────────────────────
  {
    code: "3000",
    title: "Owner's Capital",
    type: "equity",
    subcategory: "capital",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Initial and additional capital invested by owner",
      isDefault: true,
      accountPurpose: "owner-capital",
    },
  },
  {
    code: "3100",
    title: "Retained Earnings",
    type: "equity",
    subcategory: "retained-earnings",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Accumulated profits retained in business",
      isDefault: true,
      accountPurpose: "retained-earnings",
    },
  },
  {
    code: "3200",
    title: "Owner's Drawings",
    type: "equity",
    subcategory: "drawings",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Money withdrawn by owner for personal use",
      accountPurpose: "drawings",
    },
  },

  // ─── REVENUE (4000-4999) ───────────────────────────────────────────────────
  {
    code: "4000",
    title: "Sales Revenue",
    type: "revenue",
    subcategory: "sales",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Revenue from food and beverage sales",
      isDefault: true,
      accountPurpose: "sales-revenue",
    },
  },
  {
    code: "4100",
    title: "Service Charge Revenue",
    type: "revenue",
    subcategory: "service-income",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Service charges earned from customers",
      isDefault: true,
      accountPurpose: "service-charge-revenue",
    },
  },

  // ─── COST OF GOODS SOLD (5000-5999) ────────────────────────────────────────
  {
    code: "5000",
    title: "Cost of Goods Sold",
    type: "expense",
    subcategory: "cogs",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Direct cost of inventory sold",
      isDefault: true,
      accountPurpose: "cogs",
    },
  },

  // ─── OPERATING EXPENSES (6000-9999) ────────────────────────────────────────
  {
    code: "6000",
    title: "Salaries and Wages",
    type: "expense",
    subcategory: "payroll",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Employee salaries, wages, and benefits",
      accountPurpose: "salaries-expense",
    },
  },
  {
    code: "6100",
    title: "Rent Expense",
    type: "expense",
    subcategory: "occupancy",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Monthly rent for business premises",
      accountPurpose: "rent-expense",
    },
  },
  {
    code: "6200",
    title: "Utilities Expense",
    type: "expense",
    subcategory: "utilities",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Electricity, water, gas, internet",
      accountPurpose: "utilities-expense",
    },
  },
  {
    code: "6300",
    title: "Supplies Expense",
    type: "expense",
    subcategory: "supplies",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Office and cleaning supplies",
      accountPurpose: "supplies-expense",
    },
  },
  {
    code: "6400",
    title: "Marketing and Advertising",
    type: "expense",
    subcategory: "marketing",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Marketing, advertising, promotions",
      accountPurpose: "marketing-expense",
    },
  },
  {
    code: "6500",
    title: "Repairs and Maintenance",
    type: "expense",
    subcategory: "maintenance",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Equipment repairs and maintenance",
      accountPurpose: "maintenance-expense",
    },
  },
  {
    code: "6600",
    title: "Discounts Given",
    type: "expense",
    subcategory: "discounts",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Discounts and promotional allowances given",
      isDefault: true,
      accountPurpose: "discount-expense",
    },
  },
  {
    code: "6700",
    title: "Miscellaneous Expenses",
    type: "expense",
    subcategory: "other",
    currency: "PKR",
    openingBalance: 0,
    currentBalance: 0,
    isActive: true,
    metadata: {
      description: "Other operating expenses",
      accountPurpose: "miscellaneous-expense",
    },
  },
];

/**
 * Settings for default account mappings
 * These link transaction types to specific accounts
 */
const DEFAULT_SETTINGS = [
  { key: "defaultCashAccountId", value: null, description: "Default cash account for POS transactions" },
  { key: "defaultBankAccountId", value: null, description: "Default bank account for payments" },
  { key: "defaultInventoryAccountId", value: null, description: "Default inventory asset account" },
  { key: "defaultSalesAccountId", value: null, description: "Default sales revenue account" },
  { key: "defaultCogsAccountId", value: null, description: "Default cost of goods sold account" },
  { key: "defaultTaxPayableAccountId", value: null, description: "Default GST/sales tax payable account" },
  { key: "defaultServiceChargeAccountId", value: null, description: "Default service charge revenue account" },
  { key: "defaultDiscountAccountId", value: null, description: "Default discount expense account" },
  { key: "defaultAPAccountId", value: null, description: "Default accounts payable account" },
  { key: "defaultARAccountId", value: null, description: "Default accounts receivable account" },
  { key: "defaultCapitalAccountId", value: null, description: "Default owner's capital account" },
  { key: "defaultRetainedEarningsAccountId", value: null, description: "Default retained earnings account" },
];

async function seedDefaultAccounts() {
  try {
    await connectDB();
    console.log("📊 Starting default chart of accounts setup...");

    // Check if accounts already exist
    const existingCount = await LedgerAccount.countDocuments();
    if (existingCount > 0) {
      console.log(`ℹ️  ${existingCount} accounts already exist. Skipping seed.`);
      process.exit(0);
    }

    // Insert all default accounts
    console.log(`📝 Creating ${DEFAULT_ACCOUNTS.length} default accounts...`);
    const createdAccounts = await LedgerAccount.insertMany(DEFAULT_ACCOUNTS);
    console.log(`✅ Created ${createdAccounts.length} accounts successfully!`);

    // Map accounts by purpose for easy lookup
    const accountMap: Record<string, any> = {};
    createdAccounts.forEach((account) => {
      const purpose = account.metadata?.accountPurpose;
      if (purpose) {
        accountMap[purpose] = account;
      }
    });

    // Create settings with actual account IDs
    console.log("🔧 Creating default account settings...");
    const settingsToCreate = [
      {
        key: "defaultCashAccountId",
        value: accountMap["cash-drawer"]?._id?.toString() || null,
        description: "Default cash account for POS transactions",
      },
      {
        key: "defaultBankAccountId",
        value: accountMap["main-bank"]?._id?.toString() || null,
        description: "Default bank account for payments",
      },
      {
        key: "defaultInventoryAccountId",
        value: accountMap["inventory-asset"]?._id?.toString() || null,
        description: "Default inventory asset account",
      },
      {
        key: "defaultSalesAccountId",
        value: accountMap["sales-revenue"]?._id?.toString() || null,
        description: "Default sales revenue account",
      },
      {
        key: "defaultCogsAccountId",
        value: accountMap["cogs"]?._id?.toString() || null,
        description: "Default cost of goods sold account",
      },
      {
        key: "defaultTaxPayableAccountId",
        value: accountMap["tax-payable"]?._id?.toString() || null,
        description: "Default GST/sales tax payable account",
      },
      {
        key: "defaultServiceChargeAccountId",
        value: accountMap["service-charge-revenue"]?._id?.toString() || null,
        description: "Default service charge revenue account",
      },
      {
        key: "defaultDiscountAccountId",
        value: accountMap["discount-expense"]?._id?.toString() || null,
        description: "Default discount expense account",
      },
      {
        key: "defaultAPAccountId",
        value: accountMap["default-ap"]?._id?.toString() || null,
        description: "Default accounts payable account",
      },
      {
        key: "defaultARAccountId",
        value: accountMap["default-ar"]?._id?.toString() || null,
        description: "Default accounts receivable account",
      },
      {
        key: "defaultCapitalAccountId",
        value: accountMap["owner-capital"]?._id?.toString() || null,
        description: "Default owner's capital account",
      },
      {
        key: "defaultRetainedEarningsAccountId",
        value: accountMap["retained-earnings"]?._id?.toString() || null,
        description: "Default retained earnings account",
      },
    ];

    // Use upsert to avoid duplicates
    for (const setting of settingsToCreate) {
      await Setting.findOneAndUpdate(
        { key: setting.key },
        { $set: setting },
        { upsert: true, new: true }
      );
    }

    console.log(`✅ Created ${settingsToCreate.length} account settings!`);
    console.log("\n📊 Chart of Accounts Summary:");
    console.log("   Assets:      ", createdAccounts.filter((a) => a.type === "asset" || a.type === "bank" || a.type === "receivable").length);
    console.log("   Liabilities: ", createdAccounts.filter((a) => a.type === "liability").length);
    console.log("   Equity:      ", createdAccounts.filter((a) => a.type === "equity").length);
    console.log("   Revenue:     ", createdAccounts.filter((a) => a.type === "revenue").length);
    console.log("   Expenses:    ", createdAccounts.filter((a) => a.type === "expense").length);
    console.log("\n🎉 Default chart of accounts setup complete!");

    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding default accounts:", error);
    process.exit(1);
  }
}

// Run the seed function
seedDefaultAccounts();
