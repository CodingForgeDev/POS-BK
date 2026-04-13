import mongoose from "mongoose";

const PurchaseLineSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator(v: number) {
          return typeof v === "number" && v > 0;
        },
        message: "Line quantity must be greater than 0",
      },
    },
    unitCost: { type: Number, required: true, min: 0 },
    packSize: { type: Number, default: null },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const PurchaseSchema = new mongoose.Schema(
  {
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    referenceNumber: { type: String, default: "", trim: true },
    receivedAt: { type: Date, required: true },
    lines: {
      type: [PurchaseLineSchema],
      required: true,
      validate: {
        validator(v: unknown[]) {
          return Array.isArray(v) && v.length > 0;
        },
        message: "At least one line is required",
      },
    },
    totalAmount: { type: Number, required: true, min: 0 },
    notes: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["posted", "voided"], default: "posted" },
  },
  { timestamps: true }
);

PurchaseSchema.index({ supplier: 1, receivedAt: -1 });
PurchaseSchema.index({ receivedAt: -1 });

export default (mongoose.models.Purchase || mongoose.model("Purchase", PurchaseSchema)) as mongoose.Model<any>;
