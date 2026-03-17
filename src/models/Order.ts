import mongoose from "mongoose";

const OrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    notes: { type: String, default: "" },
    subtotal: { type: Number, required: true },
    /** When true, item was added to an existing ready order — kitchen should prepare only these. */
    isAddOn: { type: Boolean, default: false },
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
    promisedPrepMinutes: { type: Number, default: null },
    /** Set when status becomes "preparing" — used for countdown timer on kitchen display. */
    preparingStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default (mongoose.models.Order || mongoose.model("Order", OrderSchema)) as mongoose.Model<any>;


