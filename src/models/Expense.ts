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

export default (mongoose.models.Expense || mongoose.model("Expense", ExpenseSchema)) as mongoose.Model<any>;


