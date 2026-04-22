import mongoose from "mongoose";

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
        _id: false,
      },
    ],
    subtotal: { type: Number, required: true },
    taxRate: { type: Number, default: 10 },
    taxAmount: { type: Number, default: 0 },
    discountType: { type: String, enum: ["percentage", "fixed", "none"], default: "none" },
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
    paymentAccountDiscountType: { type: String, enum: ["percentage", "fixed", "none"], default: "none" },
    paymentAccountDiscountValue: { type: Number, default: 0 },
    paymentAccountDiscountAmount: { type: Number, default: 0 },
    amountPaid: { type: Number, required: true },
    changeGiven: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["paid", "refunded", "partial"],
      default: "paid",
    },
    notes: { type: String, default: "" },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default (mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema)) as mongoose.Model<any>;


