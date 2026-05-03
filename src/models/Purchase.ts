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
    paidAmount: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "" },
    paymentMethod: { type: String, enum: ["cash", "credit"], default: "credit" },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "partial", "paid"],
      default: "unpaid",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["posted", "voided"], default: "posted" },
  },
  { timestamps: true }
);

// Auto-update paymentStatus based on paidAmount
PurchaseSchema.pre("save", function (next) {
  if (this.paymentMethod === "cash") {
    this.paidAmount = this.totalAmount;
    this.paymentStatus = "paid";
  } else if (this.paidAmount >= this.totalAmount) {
    this.paymentStatus = "paid";
  } else if (this.paidAmount > 0) {
    this.paymentStatus = "partial";
  } else {
    this.paymentStatus = "unpaid";
  }
  next();
});

PurchaseSchema.index({ supplier: 1, receivedAt: -1 });
PurchaseSchema.index({ receivedAt: -1 });
PurchaseSchema.index({ paymentStatus: 1 });

export default (mongoose.models.Purchase || mongoose.model("Purchase", PurchaseSchema)) as mongoose.Model<any>;
