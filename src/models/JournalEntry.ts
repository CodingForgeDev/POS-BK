import mongoose from "mongoose";

const JournalEntryLineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    accountName: { type: String, required: true, trim: true },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const JournalEntrySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    reference: { type: String, default: "" },
    description: { type: String, default: "" },
    lines: { type: [JournalEntryLineSchema], required: true, validate: [(v: any[]) => v.length > 0, "At least one line is required"] },
    totalDebit: { type: Number, required: true, default: 0 },
    totalCredit: { type: Number, required: true, default: 0 },
    source: {
      type: String,
      enum: [
        "POS",
        "EXPENSE",
        "PURCHASE",
        "RETURN",
        "PAYMENT",
        "CLOSING",
        "COUNTER",
        "COUNTER_CLOSE",
        "COUNTER_DISBURSE",
        "MANUAL",
      ],
      default: "MANUAL",
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: ["draft", "posted"], default: "posted" },
    // Optional POS billing breakdown snapshot used by ledger/journal/report UIs.
    grossSubtotal: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    netAfterDiscount: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    serviceChargeAmount: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
  },
  { timestamps: true }
);

JournalEntrySchema.index(
  { source: 1, sourceId: 1 },
  { unique: true, partialFilterExpression: { source: { $ne: "MANUAL" }, sourceId: { $exists: true, $ne: null } } }
);

JournalEntrySchema.pre("validate", function (next) {
  if (this.totalDebit !== this.totalCredit) {
    return next(new Error("Journal entry must balance debit and credit"));
  }
  return next();
});

export default (
  mongoose.models.JournalEntry || mongoose.model("JournalEntry", JournalEntrySchema)
) as mongoose.Model<any>;
