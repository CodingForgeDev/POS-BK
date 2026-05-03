import mongoose from "mongoose";

/**
 * Payment Model
 * Tracks all payment transactions (both supplier payments and customer payments)
 * Links to journal entries for accounting integration
 */

const PaymentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["supplier", "customer"],
      required: true,
    },
    
    // Reference to the entity
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    
    // Payment details
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentDate: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    paymentMethod: {
      type: String,
      enum: ["cash", "bank_transfer", "card", "cheque"],
      default: "cash",
    },
    
    // Reference and notes
    referenceNumber: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
    },
    
    // Accounting linkage
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalEntry",
      default: null,
    },
    
    // Related documents
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
    },
    
    // Who recorded this payment
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    
    // Status
    status: {
      type: String,
      enum: ["posted", "voided"],
      default: "posted",
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
PaymentSchema.index({ type: 1, paymentDate: -1 });
PaymentSchema.index({ supplierId: 1, paymentDate: -1 });
PaymentSchema.index({ customerId: 1, paymentDate: -1 });
PaymentSchema.index({ status: 1 });

// Validation: Either supplierId or customerId must be set based on type
PaymentSchema.pre("save", function (next) {
  if (this.type === "supplier" && !this.supplierId) {
    return next(new Error("supplierId is required for supplier payments"));
  }
  if (this.type === "customer" && !this.customerId) {
    return next(new Error("customerId is required for customer payments"));
  }
  next();
});

export default (mongoose.models.Payment || mongoose.model("Payment", PaymentSchema)) as mongoose.Model<any>;
