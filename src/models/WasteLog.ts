import mongoose from "mongoose";

/**
 * Tracks inventory/ingredient waste that occurs when a refund is processed on a
 * prepared item. Unlike packaged/ready items, prepared food cannot be returned to
 * stock — ingredients are already consumed. This log keeps COGS accurate and
 * feeds the manager waste report.
 */
const WasteLogSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    /** Cost of the wasted item(s) based on product.costPrice — used for COGS reporting. */
    cost: { type: Number, default: 0 },
    reason: {
      type: String,
      enum: ["customer_changed_mind", "wrong_order", "quality_issue", "refund", "other"],
      default: "refund",
    },
    notes: { type: String, default: "" },
    loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

WasteLogSchema.index({ invoice: 1 });
WasteLogSchema.index({ order: 1 });
WasteLogSchema.index({ createdAt: -1 });

export default (mongoose.models.WasteLog ||
  mongoose.model("WasteLog", WasteLogSchema)) as mongoose.Model<any>;
