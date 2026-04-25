import mongoose from "mongoose";

const RefundRequestItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    refundQuantity: { type: Number, required: true },
    refundAmount: { type: Number, required: true },
  },
  { _id: false }
);

/**
 * CRITICAL: Do NOT set any `default` values on RefundRequestSchema fields.
 *
 * When Mongoose sees a nested schema with defaults, it eagerly initializes
 * the embedded object to `{ status: "pending", items: [], notes: "", ... }`
 * even when the parent field is set to `default: null`.
 *
 * This creates a "ghost" refundRequest that looks pending but has no
 * requestedBy/requestedAt — causing the 500 error when a cashier tries
 * to submit a real refund request (the ghost passes the pending check).
 *
 * Fix: Remove all defaults from RefundRequestSchema. The router always
 * sets every field explicitly when creating a refundRequest, so defaults
 * are not needed here.
 */
const RefundRequestSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    requestedAt: { type: Date },
    notes: { type: String },
    items: { type: [RefundRequestItemSchema] },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    approvalNotes: { type: String },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedAt: { type: Date },
    rejectionNotes: { type: String },
  },
  { _id: false }
);

const InvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    customerName: { type: String, default: "Walk-in" },
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        subtotal: { type: Number, required: true },
        discount: { type: Number, default: 0 },
        tax: { type: Number, default: 0 },
        total: { type: Number, required: true },
        cost: { type: Number, default: 0 },
        _id: false,
      },
    ],
    subtotal: { type: Number, required: true },
    taxRate: { type: Number, default: 10 },
    taxAmount: { type: Number, default: 0 },
    discountType: {
      type: String,
      enum: ["percentage", "fixed", "none"],
      default: "none",
    },
    discountValue: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    serviceChargeAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "debit_card", "credit_card", "gsb_card", "digital", "split"],
      required: true,
    },
    paymentAccountName: { type: String, default: "" },
    paymentAccountDiscountType: {
      type: String,
      enum: ["percentage", "fixed", "none"],
      default: "none",
    },
    paymentAccountDiscountValue: { type: Number, default: 0 },
    paymentAccountDiscountAmount: { type: Number, default: 0 },
    amountPaid: { type: Number, required: true },
    changeGiven: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["paid", "refunded", "partial"],
      default: "paid",
    },
    // null until a refund request is actually submitted
    refundRequest: { type: RefundRequestSchema, default: null },
    refundedAt: { type: Date, default: null },
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    refundNotes: { type: String, default: "" },
    notes: { type: String, default: "" },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default (mongoose.models.Invoice ||
  mongoose.model("Invoice", InvoiceSchema)) as mongoose.Model<any>;