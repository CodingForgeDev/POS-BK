import mongoose from "mongoose";

const ExpenseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["payroll", "occupancy", "utilities", "supplies", "food", "marketing", "maintenance", "miscellaneous", "cogs", "depreciation", "interest", "taxes"],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true },
    paymentMethod: {
      type: String,
      enum: ["cash", "bank_transfer", "card"],
      default: "cash",
    },
    /** When paymentMethod is bank_transfer, which Pakistani bank was used */
    bankName: { type: String, default: "", trim: true },
    paidTo: { type: String, default: "" },
    notes: { type: String, default: "" },
    isRecurring: { type: Boolean, default: false },
    recurringFrequency: {
      type: String,
      enum: ["daily", "weekly", "monthly", "yearly", "none"],
      default: "none",
    },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    referenceNumber: { type: String, default: "" },
    /** For payroll expenses, link to the employee being paid */
    linkedEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    /** Snapshot of employee's salaryType at time of expense creation (hourly/weekly/monthly) */
    employeeSalaryType: { type: String, default: null },
    expenseAccount: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
    paymentAccount: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
  },
  { timestamps: true }
);

// Counter schema for sequential expense reference numbers
const ExpenseCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: "expense_counters" }
);

const ExpenseCounter = mongoose.models.ExpenseCounter || mongoose.model("ExpenseCounter", ExpenseCounterSchema);

export async function getNextExpenseNumber(): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateKey = `${year}${month}${day}`;
  
  const counter = (await (ExpenseCounter as mongoose.Model<any>).findOneAndUpdate(
    { _id: `EXP-${dateKey}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean()) as any;
  return `EXP-${dateKey}-${String(counter.seq || 1).padStart(4, "0")}`;
}

export default (mongoose.models.Expense || mongoose.model("Expense", ExpenseSchema)) as mongoose.Model<any>;


