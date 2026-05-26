import mongoose from "mongoose";

const DisbursementSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "CounterSession", required: true },
    amount: { type: Number, required: true },
    remarks: { type: String, required: true, trim: true },
    authorizedBy: { type: String, required: true, trim: true },
    timestamp: { type: Date, required: true },
    runningCashAfter: { type: Number, default: 0 },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

DisbursementSchema.index({ sessionId: 1, timestamp: -1 });

export default (
  mongoose.models.Disbursement ||
  mongoose.model("Disbursement", DisbursementSchema)
) as mongoose.Model<any>;
