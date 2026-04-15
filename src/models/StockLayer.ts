import mongoose from "mongoose";

const StockLayerSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: ["purchase", "opening", "adjustment"],
      required: true,
    },
    /** Set when sourceType is "purchase". */
    purchase: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null },
    /** Index of line on Purchase document when sourceType is "purchase". */
    lineIndex: { type: Number, default: 0 },
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    adjustmentType: { type: String, enum: ["add", "remove"], default: null },
    receivedAt: { type: Date, required: true },
    quantityOriginal: { type: Number, required: true, min: 0 },
    quantityRemaining: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

StockLayerSchema.index({ inventoryItem: 1, receivedAt: 1, _id: 1 });
StockLayerSchema.index({ purchase: 1 });

export default (mongoose.models.StockLayer || mongoose.model("StockLayer", StockLayerSchema)) as mongoose.Model<any>;
