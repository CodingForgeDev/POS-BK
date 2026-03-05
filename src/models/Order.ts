import mongoose from "mongoose";

const OrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    notes: { type: String, default: "" },
    subtotal: { type: Number, required: true },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ["dine-in", "takeaway", "delivery"],
      required: true,
    },
    status: {
      type: String,
      enum: ["open", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"],
      default: "open",
    },
    items: [OrderItemSchema],
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    customerName: { type: String, default: "Walk-in" },
    tableNumber: { type: String, default: "" },
    subtotal: { type: Number, required: true },
    taxAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    notes: { type: String, default: "" },
    servedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    kotPrinted: { type: Boolean, default: false },
    kotPrintedAt: { type: Date },
  },
  { timestamps: true }
);

export default (mongoose.models.Order || mongoose.model("Order", OrderSchema)) as mongoose.Model<any>;


