import mongoose from "mongoose";

const ConsumptionLineSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    quantityConsumed: { type: Number, required: true },
  },
  { _id: false }
);

const InventoryConsumptionSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    lines: { type: [ConsumptionLineSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default (mongoose.models.InventoryConsumption ||
  mongoose.model("InventoryConsumption", InventoryConsumptionSchema)) as mongoose.Model<any>;
