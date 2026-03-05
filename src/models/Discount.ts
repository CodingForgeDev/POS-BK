import mongoose from "mongoose";

const DiscountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    type: { type: String, enum: ["percentage", "fixed"], required: true },
    value: { type: Number, required: true, min: 0 },
    appliesTo: {
      type: String,
      enum: ["entire_bill", "specific_items", "category"],
      default: "entire_bill",
    },
    applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
    minOrderAmount: { type: Number, default: 0 },
    maxDiscountAmount: { type: Number, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    usageLimit: { type: Number, default: null },
    usageCount: { type: Number, default: 0 },
    requiresAuth: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

export default (mongoose.models.Discount || mongoose.model("Discount", DiscountSchema)) as mongoose.Model<any>;


