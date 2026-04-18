import mongoose from "mongoose";

/** One ingredient line: amount consumed per 1 sold unit of this product (same unit meaning as the inventory row). */
const RecipeLineSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    quantityPerUnit: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ProductModifierOptionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    priceDelta: { type: Number, default: 0 },
  },
  { _id: false }
);

const ProductModifierGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    required: { type: Boolean, default: false },
    multiSelect: { type: Boolean, default: false },
    options: { type: [ProductModifierOptionSchema], default: [] },
  },
  { _id: false }
);

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
    isReadyItem: { type: Boolean, default: false },
    allergens: [{ type: String }],
    sortOrder: { type: Number, default: 0 },
    recipeLines: { type: [RecipeLineSchema], default: [] },
    modifierGroups: { type: [ProductModifierGroupSchema], default: [] },
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


