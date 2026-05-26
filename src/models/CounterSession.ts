import mongoose from "mongoose";

const DenomSchema = new mongoose.Schema(
  {
    denom: { type: Number, required: true },
    qty: { type: Number, default: 0 },
  },
  { _id: false }
);

const DisbursementEmbedSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    remarks: { type: String, required: true },
    authorizedBy: { type: String, required: true },
    timestamp: { type: Date, required: true },
    runningCashAfter: { type: Number, default: 0 },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
  },
  { _id: false }
);

const CounterSessionSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["open", "closed"], default: "open" },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cashierName: { type: String, default: "" },
    counterName: { type: String, default: "" },
    // Sales totals (reconciliation only; card/bank posted at sale time)
    cashSales: { type: Number, default: 0 },
    cardSales: { type: Number, default: 0 },
    bankTransferSales: { type: Number, default: 0 },
    totalSales: { type: Number, default: 0 },
    // Cash movement / reconciliation
    sessionOpeningBalance: { type: Number, default: 0 },
    countedTotal: { type: Number, default: 0 },
    countedDenominations: { type: [DenomSchema], default: [] },
    openingBalance: { type: Number, default: 0 },
    openingDenominations: { type: [DenomSchema], default: [] },
    depositedAmount: { type: Number, default: 0 },
    tomorrowOpening: { type: Number, default: 0 },
    netDeposit: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    disbursements: { type: [DisbursementEmbedSchema], default: [] },
    totalDisbursed: { type: Number, default: 0 },
    remarks: { type: String, default: "" },
    expectedCashInHand: { type: Number, default: 0 },
    closeJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
  },
  { timestamps: true }
);

CounterSessionSchema.index({ status: 1, openedAt: -1 });
CounterSessionSchema.index({ closedAt: -1 });

if (mongoose.models.CounterSession) {
  delete mongoose.models.CounterSession;
}

export default mongoose.model("CounterSession", CounterSessionSchema) as mongoose.Model<any>;
