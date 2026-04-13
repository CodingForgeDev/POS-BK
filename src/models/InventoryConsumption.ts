import mongoose from "mongoose";

const FifoAllocationSchema = new mongoose.Schema(
  {
    stockLayer: { type: mongoose.Schema.Types.ObjectId, ref: "StockLayer", required: true },
    quantity: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ConsumptionLineSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    quantityConsumed: { type: Number, required: true },
    fifoAllocations: { type: [FifoAllocationSchema], default: [] },
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
