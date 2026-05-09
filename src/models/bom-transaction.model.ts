import mongoose, { Document, Schema, Types } from "mongoose";

export interface IBOMRawMaterialLine {
  inventoryItem: Types.ObjectId;
  itemCode: string;
  itemName: string;
  quantity: number;
  rate: number;
  amount: number;
  unit: string;
  remarks: string;
}

export interface IBOMProducedItemLine {
  inventoryItem: Types.ObjectId;
  itemCode: string;
  itemName: string;
  quantity: number;
  rate: number;
  amount: number;
  unit: string;
  remarks: string;
}

export interface IProducedMenuItem {
  menuProductId: Types.ObjectId;
  menuProductName: string;
  quantity: number;
  costPerUnit: number;
  salePrice: number;
  linkedReadyInventory?: Types.ObjectId;  // ← NEW: Auto-linked ready inventory
  linkedReadyInventoryName?: string;       // ← For display
}

export type BOMStatus = "draft" | "posted" | "reversed";

export interface IBOMTransaction extends Document {
  transactionNo: string;
  referenceNo: string;
  date: Date;
  remarks: string;
  status: BOMStatus;
  rawMaterials: IBOMRawMaterialLine[];
  producedItems: IBOMProducedItemLine[];
  producedMenuItems: IProducedMenuItem[];
  totalRawCost: number;
  totalRawQty: number;
  totalProducedQty: number;
  totalProducedValue: number;
  variance: number;
  costPerUnit: number;
  journalEntryId?: Types.ObjectId | null;
  postedBy?: Types.ObjectId | null;
  reversedBy?: Types.ObjectId | null;
  reversalNote?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const RawMaterialLineSchema = new Schema<IBOMRawMaterialLine>(
  {
    inventoryItem: { type: Schema.Types.ObjectId, ref: "Inventory", required: true },
    itemCode: { type: String, required: true, trim: true },
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, default: "Unit" },
    remarks: { type: String, default: "" },
  },
  { _id: false }
);

const ProducedItemLineSchema = new Schema<IBOMProducedItemLine>(
  {
    inventoryItem: { type: Schema.Types.ObjectId, ref: "Inventory", required: true },
    itemCode: { type: String, required: true, trim: true },
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, default: "Unit" },
    remarks: { type: String, default: "" },
  },
  { _id: false }
);

const ProducedMenuItemSchema = new Schema<IProducedMenuItem>({
  menuProductId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  menuProductName: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  costPerUnit: { type: Number, required: true, min: 0 },
  salePrice: { type: Number, required: true, min: 0 },
  linkedReadyInventory: { type: Schema.Types.ObjectId, ref: "Inventory" }, // ← NEW
  linkedReadyInventoryName: { type: String, trim: true },                  // ← NEW
}, { _id: false });

const BOMCounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: "bom_counters" }
);

const BOMCounter = mongoose.models.BOMCounter || mongoose.model("BOMCounter", BOMCounterSchema);

async function getNextBOMNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const counter = (await (BOMCounter as mongoose.Model<any>).findOneAndUpdate(
    { _id: `BOM-${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean()) as any;
  return `BOM-${year}-${String(counter.seq || 1).padStart(4, "0")}`;
}

const BOMTransactionSchema = new Schema<IBOMTransaction>(
  {
    transactionNo: { type: String, required: true, unique: true, trim: true },
    referenceNo: { type: String, default: "" },
    date: { type: Date, required: true },
    remarks: { type: String, default: "" },
    status: { type: String, enum: ["draft", "posted", "reversed"], default: "draft" },
    rawMaterials: { type: [RawMaterialLineSchema], default: [] },
    producedItems: { type: [ProducedItemLineSchema], default: [] },
    producedMenuItems: { type: [ProducedMenuItemSchema], default: [] },
    totalRawCost: { type: Number, default: 0 },
    totalRawQty: { type: Number, default: 0 },
    totalProducedQty: { type: Number, default: 0 },
    totalProducedValue: { type: Number, default: 0 },
    variance: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reversedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reversalNote: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

BOMTransactionSchema.pre("validate", async function (next) {
  if (this.isNew && !this.transactionNo) {
    try {
      this.transactionNo = await getNextBOMNumber();
    } catch (error) {
      return next(error as Error);
    }
  }

  let rawCost = 0;
  let rawQty = 0;
  let producedQty = 0;
  let producedValue = 0;

  for (const raw of this.rawMaterials || []) {
    raw.amount = Number((raw.quantity * raw.rate).toFixed(2));
    rawCost += raw.amount;
    rawQty += Number(raw.quantity || 0);
  }

  for (const produced of this.producedItems || []) {
    produced.amount = Number((produced.quantity * produced.rate).toFixed(2));
    producedValue += produced.amount;
    producedQty += Number(produced.quantity || 0);
  }

  if ((!this.producedItems?.length || producedQty === 0) && this.producedMenuItems?.length) {
    for (const produced of this.producedMenuItems) {
      const quantity = Number(produced.quantity || 0);
      const amount = Number((quantity * Number(produced.costPerUnit || 0)).toFixed(2));
      producedValue += amount;
      producedQty += quantity;
    }
  }

  this.totalRawCost = Number(rawCost.toFixed(2));
  this.totalRawQty = Number(rawQty.toFixed(4));
  this.totalProducedQty = Number(producedQty.toFixed(4));
  this.totalProducedValue = Number(producedValue.toFixed(2));
  this.variance = Number((this.totalProducedValue - this.totalRawCost).toFixed(2));
  this.costPerUnit = this.totalProducedQty > 0 ? Number((this.totalRawCost / this.totalProducedQty).toFixed(4)) : 0;

  next();
});

export default mongoose.models.BOMTransaction || mongoose.model<IBOMTransaction>("BOMTransaction", BOMTransactionSchema);
