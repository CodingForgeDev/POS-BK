import mongoose from "mongoose";

const ReturnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: false },
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: false },
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    condition: { type: String, enum: ["resellable", "damaged", "expired", "wrong_item", ""], default: "" },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const ReturnTransactionSchema = new mongoose.Schema(
  {
    returnType: { type: String, enum: ["sale", "purchase"], required: true },
    date: { type: Date, required: true },
    reference: { type: String, default: "" },
    relatedInvoice: { type: String, default: "" },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null },
    customerName: { type: String, default: "" },
    supplierName: { type: String, default: "" },
    account: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
    accountName: { type: String, default: "" },
    reason: { type: String, default: "" },
    creditType: { type: String, enum: ["credit_note", "refund", "replacement"], default: "credit_note" },
    items: { type: [ReturnItemSchema], default: [] },
    totalAmount: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "processed", "rejected"], default: "pending" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default (
  mongoose.models.ReturnTransaction || mongoose.model("ReturnTransaction", ReturnTransactionSchema)
) as mongoose.Model<any>;
