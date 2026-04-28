import mongoose from "mongoose";

const LedgerAccountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, unique: true },
    title: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["asset", "bank", "receivable", "liability", "equity", "expense", "revenue"],
      default: "asset",
    },
    address: { type: String, default: "" },
    contact: { type: String, default: "" },
    openingBalance: { type: Number, default: 0 },
    currentBalance: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default (
  mongoose.models.LedgerAccount || mongoose.model("LedgerAccount", LedgerAccountSchema)
) as mongoose.Model<any>;
