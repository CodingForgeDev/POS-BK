import mongoose from "mongoose";

const ExpenseBankSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

ExpenseBankSchema.index({ name: 1 }, { unique: true });

export default (mongoose.models.ExpenseBank ||
  mongoose.model("ExpenseBank", ExpenseBankSchema)) as mongoose.Model<any>;
