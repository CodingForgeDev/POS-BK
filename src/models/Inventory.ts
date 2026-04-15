import mongoose from "mongoose";

const InventorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, unique: true, sparse: true },
    category: { type: String, default: "" },
    unit: { type: String, required: true },
    currentStock: { type: Number, required: true, default: 0 },
    /** Quantity held for orders in progress (e.g. kitchen preparing). */
    reservedStock: { type: Number, required: true, default: 0 },
    minimumStock: { type: Number, default: 0 },
    maximumStock: { type: Number, default: 1000 },
    defaultPackSize: { type: Number, default: null },
    costPerUnit: { type: Number, default: 0 },
    wastageAmount: { type: Number, default: 0 },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    supplierName: { type: String, default: "" },
    supplierContact: { type: String, default: "" },
    lastRestockedAt: { type: Date, default: null },
    lastRestockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default (mongoose.models.Inventory || mongoose.model("Inventory", InventorySchema)) as mongoose.Model<any>;


