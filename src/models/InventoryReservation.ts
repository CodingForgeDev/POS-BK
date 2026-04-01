import mongoose from "mongoose";

const ReservationLineSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    quantityReserved: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const InventoryReservationSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    status: { type: String, enum: ["active", "consumed", "released"], default: "active" },
    lines: { type: [ReservationLineSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    consumedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default (mongoose.models.InventoryReservation ||
  mongoose.model("InventoryReservation", InventoryReservationSchema)) as mongoose.Model<any>;

