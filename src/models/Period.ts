import mongoose, { Schema, Document } from "mongoose";

export interface IPeriod extends Document {
  name: string;
  startDate: Date;
  endDate: Date;
  status: "open" | "closed" | "locked";
  closingJournalEntryId?: mongoose.Types.ObjectId;
  netProfit?: number;
  closedBy?: mongoose.Types.ObjectId;
  closedAt?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PeriodSchema = new Schema<IPeriod>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      // e.g., "January 2024", "Q1 2024", "FY 2024"
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["open", "closed", "locked"],
      default: "open",
      // open: can post entries
      // closed: closing entry posted, can reopen
      // locked: permanently locked, cannot reopen
    },
    closingJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalEntry",
      default: null,
    },
    netProfit: {
      type: Number,
      default: 0,
      // Calculated net profit for the period
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
PeriodSchema.index({ startDate: 1, endDate: 1 });
PeriodSchema.index({ status: 1 });

// Validation: endDate must be after startDate
PeriodSchema.pre("save", function (next) {
  if (this.endDate <= this.startDate) {
    return next(new Error("End date must be after start date"));
  }
  next();
});

// Method to check if a date falls within this period
PeriodSchema.methods.includesDate = function (date: Date): boolean {
  return date >= this.startDate && date <= this.endDate;
};

const Period = mongoose.model<IPeriod>("Period", PeriodSchema);

export default Period;
