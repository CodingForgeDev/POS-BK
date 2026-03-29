/**
 * Seeds realistic March cafe expenses (PKR-style sample data; year = current year or SEED_EXPENSE_YEAR).
 * Usage: npm run seed:expenses
 *
 * - Loads .env.local then .env (same order as server/src/lib/env.ts)
 * - Maps display labels → Expense schema enums
 * - Idempotent: removes any existing rows with the same titles, then inserts
 * - Sets addedBy to first admin user (or any user) if available
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found. Set it in server/.env or server/.env.local");
  process.exit(1);
}

const ExpenseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["salary", "rent", "electricity", "office", "food", "maintenance", "marketing", "miscellaneous"],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true },
    paymentMethod: {
      type: String,
      enum: ["cash", "bank_transfer", "card"],
      default: "cash",
    },
    paidTo: { type: String, default: "" },
    notes: { type: String, default: "" },
    isRecurring: { type: Boolean, default: false },
    recurringFrequency: {
      type: String,
      enum: ["daily", "weekly", "monthly", "yearly", "none"],
      default: "none",
    },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const UserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    password: String,
    role: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Expense = mongoose.models.Expense || mongoose.model("Expense", ExpenseSchema);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

/** Calendar year for seeded rows (defaults to this year so UI month filter matches). Override: SEED_EXPENSE_YEAR=2026 */
const SEED_YEAR = process.env.SEED_EXPENSE_YEAR
  ? parseInt(process.env.SEED_EXPENSE_YEAR, 10)
  : new Date().getFullYear();

/** DD/MM/… → Date; day/month from string, year from SEED_YEAR (avoids 2026 seed + 2025 PC clock = empty list). */
function parseDMY(s) {
  const [d, m] = s.split("/").map(Number);
  return new Date(SEED_YEAR, m - 1, d);
}

const CATEGORY_MAP = {
  "Salaries / Payroll": "salary",
  Rent: "rent",
  Electricity: "electricity",
  "Office Expenses": "office",
  "Food & Supplies": "food",
  Maintenance: "maintenance",
  Marketing: "marketing",
  Miscellaneous: "miscellaneous",
};

const PAYMENT_MAP = {
  Cash: "cash",
  "Bank Transfer": "bank_transfer",
  Card: "card",
};

/** Raw rows: display category + payment strings (as in your list) */
const RAW = [
  {
    title: "Barista Salary - March",
    category: "Salaries / Payroll",
    amount: 38000,
    date: "29/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Ali Raza",
    notes: "Monthly salary for senior barista",
  },
  {
    title: "Cashier Salary - March",
    category: "Salaries / Payroll",
    amount: 32000,
    date: "29/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Usman Khalid",
    notes: "Monthly salary for cashier",
  },
  {
    title: "Kitchen Helper Salary - March",
    category: "Salaries / Payroll",
    amount: 28000,
    date: "29/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Bilal Ahmed",
    notes: "Monthly salary for kitchen helper",
  },
  {
    title: "Cleaner Salary - March",
    category: "Salaries / Payroll",
    amount: 22000,
    date: "29/03/2026",
    paymentMethod: "Cash",
    paidTo: "Rasheed Jan",
    notes: "Monthly cleaning staff salary",
  },
  {
    title: "Part-time Waiter Wages",
    category: "Salaries / Payroll",
    amount: 12000,
    date: "28/03/2026",
    paymentMethod: "Cash",
    paidTo: "Hamza Tariq",
    notes: "Weekly shift wages",
  },
  {
    title: "Shop Rent - March",
    category: "Rent",
    amount: 95000,
    date: "05/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Crescent Plaza Management",
    notes: "Monthly rent for cafe outlet",
  },
  {
    title: "Storage Room Rent",
    category: "Rent",
    amount: 18000,
    date: "06/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Ahmed Commercial Properties",
    notes: "Small storage room near outlet",
  },
  {
    title: "Electricity Bill - Main Outlet",
    category: "Electricity",
    amount: 46850,
    date: "14/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "LESCO",
    notes: "Monthly electricity bill including AC and espresso machines",
  },
  {
    title: "Generator Fuel",
    category: "Electricity",
    amount: 12500,
    date: "18/03/2026",
    paymentMethod: "Cash",
    paidTo: "PSO Pump Johar Town",
    notes: "Backup generator diesel purchase",
  },
  {
    title: "UPS Battery Water & Service",
    category: "Electricity",
    amount: 2500,
    date: "20/03/2026",
    paymentMethod: "Cash",
    paidTo: "Power House Electronics",
    notes: "Routine UPS maintenance supplies",
  },
  {
    title: "Printer Paper & Receipt Rolls",
    category: "Office Expenses",
    amount: 4200,
    date: "08/03/2026",
    paymentMethod: "Cash",
    paidTo: "Metro Stationers",
    notes: "POS printer rolls and A4 paper",
  },
  {
    title: "Pens, Files & Markers",
    category: "Office Expenses",
    amount: 1850,
    date: "09/03/2026",
    paymentMethod: "Cash",
    paidTo: "City Stationery Mart",
    notes: "General office supplies",
  },
  {
    title: "Internet Bill",
    category: "Office Expenses",
    amount: 6500,
    date: "11/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "PTCL Flash Fiber",
    notes: "Monthly internet payment for POS and CCTV",
  },
  {
    title: "POS Thermal Printer Ink & Cleaning Kit",
    category: "Office Expenses",
    amount: 3200,
    date: "17/03/2026",
    paymentMethod: "Card",
    paidTo: "Tech Supplies PK",
    notes: "Accessories for POS billing equipment",
  },
  {
    title: "Milk Purchase",
    category: "Food & Supplies",
    amount: 14800,
    date: "03/03/2026",
    paymentMethod: "Cash",
    paidTo: "Al-Faisal Dairy",
    notes: "Weekly fresh milk supply",
  },
  {
    title: "Coffee Beans - Brazilian Blend",
    category: "Food & Supplies",
    amount: 26500,
    date: "04/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Roast House Pakistan",
    notes: "Premium coffee beans for espresso and latte",
  },
  {
    title: "Sugar, Tea & Syrups",
    category: "Food & Supplies",
    amount: 9800,
    date: "07/03/2026",
    paymentMethod: "Cash",
    paidTo: "Imtiaz Wholesale",
    notes: "Basic beverage ingredients",
  },
  {
    title: "Bakery Items Refill",
    category: "Food & Supplies",
    amount: 18750,
    date: "10/03/2026",
    paymentMethod: "Cash",
    paidTo: "Bake Studio",
    notes: "Croissants, brownies, cookies and muffins",
  },
  {
    title: "Chicken, Cheese & Sandwich Fillings",
    category: "Food & Supplies",
    amount: 21300,
    date: "12/03/2026",
    paymentMethod: "Cash",
    paidTo: "Fresh Foods Distributor",
    notes: "Food ingredients for sandwiches and wraps",
  },
  {
    title: "Mineral Water & Soft Drinks Stock",
    category: "Food & Supplies",
    amount: 9600,
    date: "15/03/2026",
    paymentMethod: "Cash",
    paidTo: "National Beverages",
    notes: "Retail stock for resale",
  },
  {
    title: "Takeaway Cups, Lids & Straws",
    category: "Food & Supplies",
    amount: 11200,
    date: "16/03/2026",
    paymentMethod: "Card",
    paidTo: "PackSmart Solutions",
    notes: "Disposable serving supplies",
  },
  {
    title: "Cleaning Chemicals & Dishwash",
    category: "Food & Supplies",
    amount: 4300,
    date: "19/03/2026",
    paymentMethod: "Cash",
    paidTo: "Metro Cash & Carry",
    notes: "Kitchen and floor cleaning materials",
  },
  {
    title: "Frozen Fries & Sauces",
    category: "Food & Supplies",
    amount: 7350,
    date: "22/03/2026",
    paymentMethod: "Cash",
    paidTo: "Food Point Traders",
    notes: "Fast food side items",
  },
  {
    title: "Espresso Machine Service",
    category: "Maintenance",
    amount: 14500,
    date: "13/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Coffee Machine Experts",
    notes: "Routine machine cleaning and pressure calibration",
  },
  {
    title: "AC Repair",
    category: "Maintenance",
    amount: 7800,
    date: "18/03/2026",
    paymentMethod: "Cash",
    paidTo: "Cool Breeze Services",
    notes: "Gas refill and servicing of split AC",
  },
  {
    title: "Plumbing Work in Wash Area",
    category: "Maintenance",
    amount: 3200,
    date: "21/03/2026",
    paymentMethod: "Cash",
    paidTo: "Bashir Plumbing Works",
    notes: "Leakage repair near sink",
  },
  {
    title: "POS Terminal Repair",
    category: "Maintenance",
    amount: 5600,
    date: "23/03/2026",
    paymentMethod: "Card",
    paidTo: "Digital POS Solutions",
    notes: "Touch screen response issue fixed",
  },
  {
    title: "Facebook & Instagram Ads",
    category: "Marketing",
    amount: 18000,
    date: "06/03/2026",
    paymentMethod: "Card",
    paidTo: "Meta Ads",
    notes: "Local awareness and Ramadan offer campaign",
  },
  {
    title: "Flyers Printing",
    category: "Marketing",
    amount: 5400,
    date: "09/03/2026",
    paymentMethod: "Cash",
    paidTo: "Print Hub",
    notes: "Promotional flyers for nearby offices and hostels",
  },
  {
    title: "Food Blogger Collaboration",
    category: "Marketing",
    amount: 12000,
    date: "24/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "Lahore Food Reviews",
    notes: "Promotional post and reel collaboration",
  },
  {
    title: "Loyalty Cards Printing",
    category: "Marketing",
    amount: 3500,
    date: "25/03/2026",
    paymentMethod: "Cash",
    paidTo: "Brand Print Works",
    notes: "Customer loyalty punch cards",
  },
  {
    title: "Water Dispenser Bottle Refill",
    category: "Miscellaneous",
    amount: 1800,
    date: "05/03/2026",
    paymentMethod: "Cash",
    paidTo: "Pure Water Suppliers",
    notes: "Drinking water for staff and customers",
  },
  {
    title: "Staff Tea & Meal",
    category: "Miscellaneous",
    amount: 2600,
    date: "12/03/2026",
    paymentMethod: "Cash",
    paidTo: "Local Grocery Corner",
    notes: "Refreshments for staff meeting",
  },
  {
    title: "Bank Charges",
    category: "Miscellaneous",
    amount: 950,
    date: "15/03/2026",
    paymentMethod: "Bank Transfer",
    paidTo: "HBL",
    notes: "Monthly account service charges",
  },
  {
    title: "Customer Refund",
    category: "Miscellaneous",
    amount: 1350,
    date: "20/03/2026",
    paymentMethod: "Cash",
    paidTo: "Walk-in Customer",
    notes: "Refund for wrong order issue",
  },
  {
    title: "Parking Fee for Supply Vehicle",
    category: "Miscellaneous",
    amount: 600,
    date: "26/03/2026",
    paymentMethod: "Cash",
    paidTo: "Market Parking Stand",
    notes: "Delivery vehicle temporary parking",
  },
];

function toDocuments(addedById) {
  return RAW.map((r) => {
    const category = CATEGORY_MAP[r.category];
    const paymentMethod = PAYMENT_MAP[r.paymentMethod];
    if (!category) throw new Error(`Unknown category: ${r.category}`);
    if (!paymentMethod) throw new Error(`Unknown payment: ${r.paymentMethod}`);
    const doc = {
      title: r.title,
      category,
      amount: r.amount,
      date: parseDMY(r.date),
      paymentMethod,
      paidTo: r.paidTo,
      notes: r.notes,
    };
    if (addedById) doc.addedBy = addedById;
    return doc;
  });
}

async function seedExpenses() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB");

    const titles = RAW.map((r) => r.title);
    const removed = await Expense.deleteMany({ title: { $in: titles } });
    if (removed.deletedCount > 0) {
      console.log(`✓ Removed ${removed.deletedCount} existing seed rows (same titles)`);
    }

    let addedBy = null;
    const admin = await User.findOne({ role: "admin" }).sort({ createdAt: 1 });
    if (admin) addedBy = admin._id;
    else {
      const any = await User.findOne().sort({ createdAt: 1 });
      if (any) addedBy = any._id;
    }
    if (!addedBy) {
      console.warn("⚠ No user found — expenses will be created without addedBy");
    }

    const docs = toDocuments(addedBy);
    const inserted = await Expense.insertMany(docs);
    console.log(`\n✅ Inserted ${inserted.length} expenses (March ${SEED_YEAR} sample data)\n`);

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedExpenses();
