import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, default: 0 },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    image: { type: String, default: "" },
    sku: { type: String, unique: true, sparse: true },
    isAvailable: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    taxable: { type: Boolean, default: true },
    taxRate: { type: Number, default: 10 },
    preparationTime: { type: Number, default: 10 },
    allergens: [{ type: String }],
    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ProductSchema.virtual("grossMargin").get(function () {
  if (!this.costPrice || this.costPrice === 0) return null;
  return (((this.price - this.costPrice) / this.price) * 100).toFixed(2);
});

export default (mongoose.models.Product || mongoose.model("Product", ProductSchema)) as mongoose.Model<any>;


