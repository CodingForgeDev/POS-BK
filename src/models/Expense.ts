import mongoose from "mongoose";

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

export default (mongoose.models.Expense || mongoose.model("Expense", ExpenseSchema)) as mongoose.Model<any>;


