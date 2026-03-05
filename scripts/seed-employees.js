/**
 * Seeds test employees for all roles (manager, cashier, kitchen).
 * Admin is NOT seeded here — use seed-admin.js for that.
 *
 * Usage: node scripts/seed-employees.js
 * Password for all accounts: 12345678
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

// Load .env.local
const envPath = path.join(__dirname, "../.env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] = rest.join("=").trim();
  }
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found in .env.local");
  process.exit(1);
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const UserSchema = new mongoose.Schema(
  { name: String, email: String, password: String, role: String, isActive: { type: Boolean, default: true }, phone: { type: String, default: "" } },
  { timestamps: true }
);
const EmployeeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    employeeId: { type: String, unique: true },
    position: String,
    department: String,
    salary: { type: Number, default: 0 },
    salaryType: { type: String, default: "monthly" },
    startDate: Date,
    isActive: { type: Boolean, default: true },
    emergencyContact: { name: { type: String, default: "" }, phone: { type: String, default: "" }, relationship: { type: String, default: "" } },
    address: { type: String, default: "" },
    taxFileNumber: { type: String, default: "" },
    bankAccount: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

const User = mongoose.models.User || mongoose.model("User", UserSchema);
const Employee = mongoose.models.Employee || mongoose.model("Employee", EmployeeSchema);

// ─── Employee Data ────────────────────────────────────────────────────────────

const EMPLOYEES = [
  // ── Managers ──
  {
    name: "Sara Khan",
    email: "manager1@poscafe.com",
    role: "manager",
    phone: "0300-1111111",
    position: "Floor Manager",
    department: "Operations",
    salary: 85000,
  },
  {
    name: "Bilal Ahmed",
    email: "manager2@poscafe.com",
    role: "manager",
    phone: "0300-2222222",
    position: "Shift Manager",
    department: "Operations",
    salary: 80000,
  },

  // ── Cashiers ──
  {
    name: "Ali Hassan",
    email: "cashier1@poscafe.com",
    role: "cashier",
    phone: "0301-3333333",
    position: "Senior Cashier",
    department: "Counter",
    salary: 45000,
  },
  {
    name: "Fatima Noor",
    email: "cashier2@poscafe.com",
    role: "cashier",
    phone: "0301-4444444",
    position: "Cashier",
    department: "Counter",
    salary: 40000,
  },
  {
    name: "Usman Malik",
    email: "cashier3@poscafe.com",
    role: "cashier",
    phone: "0301-5555555",
    position: "Cashier",
    department: "Counter",
    salary: 40000,
  },

  // ── Kitchen Staff ──
  {
    name: "Chef Kamran",
    email: "kitchen1@poscafe.com",
    role: "kitchen",
    phone: "0302-6666666",
    position: "Head Chef",
    department: "Kitchen",
    salary: 60000,
  },
  {
    name: "Asad Raza",
    email: "kitchen2@poscafe.com",
    role: "kitchen",
    phone: "0302-7777777",
    position: "Sous Chef",
    department: "Kitchen",
    salary: 50000,
  },
  {
    name: "Hina Baig",
    email: "kitchen3@poscafe.com",
    role: "kitchen",
    phone: "0302-8888888",
    position: "Kitchen Staff",
    department: "Kitchen",
    salary: 35000,
  },
];

// ─── Seed Function ────────────────────────────────────────────────────────────

async function seedEmployees() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB\n");

    const hashedPassword = await bcrypt.hash("12345678", 12);
    const startDate = new Date("2024-01-01");

    let created = 0;
    let skipped = 0;

    // Count existing employees to generate IDs after existing ones
    const existingCount = await Employee.countDocuments();
    let empCounter = existingCount;

    for (const emp of EMPLOYEES) {
      const existing = await User.findOne({ email: emp.email });
      if (existing) {
        console.log(`⚠  Skipped  — ${emp.email} (already exists)`);
        skipped++;
        continue;
      }

      empCounter++;
      const employeeId = `EMP-${String(empCounter).padStart(4, "0")}`;

      const user = await User.create({
        name: emp.name,
        email: emp.email,
        password: hashedPassword,
        role: emp.role,
        phone: emp.phone,
        isActive: true,
      });

      await Employee.create({
        user: user._id,
        employeeId,
        position: emp.position,
        department: emp.department,
        salary: emp.salary,
        salaryType: "monthly",
        startDate,
        isActive: true,
      });

      console.log(`✅ Created  — [${emp.role.padEnd(8)}] ${emp.name.padEnd(20)} → ${emp.email}`);
      created++;
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Total Created : ${created}`);
    console.log(`  Total Skipped : ${skipped}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n  Password for ALL accounts: 12345678\n");
    console.log("  LOGIN CREDENTIALS:");
    console.log("  ─────────────────────────────────────────────────────────");
    for (const emp of EMPLOYEES) {
      console.log(`  [${emp.role.padEnd(8)}]  ${emp.email.padEnd(35)} pw: 12345678`);
    }
    console.log("  ─────────────────────────────────────────────────────────\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedEmployees();
