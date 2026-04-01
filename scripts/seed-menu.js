/**
 * Seeds a complete fast-food restaurant menu: Categories + Products
 * Usage: node scripts/seed-menu.js  (or: npm run seed:menu)
 *
 * Notes:
 * - Loads .env.local then .env (same as server/src/lib/env.ts)
 * - Idempotent (upsert by name + category)
 * - Prices are in PKR
 * - Matches existing Category & Product schemas (price, not sellingPrice)
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found. Set it in server/.env or server/.env.local");
  process.exit(1);
}

// ─── Schemas (match server/src/models) ───────────────────────────────────────
const CategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    color: { type: String, default: "#1976d2" },
    icon: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
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
    allergens: [{ type: String }],
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Category = mongoose.models.Category || mongoose.model("Category", CategorySchema);
const Product = mongoose.models.Product || mongoose.model("Product", ProductSchema);

// ─── Data ───────────────────────────────────────────────────────────────────
const { MENU } = require("./seed-menu-data");

const CATEGORIES = [
  "Burgers",
  "Chicken Burgers",
  "Pizza",
  "Sandwiches & Subs",
  "Wraps",
  "Fried Chicken",
  "Wings",
  "Sides",
  "Sauces & Dips",
  "Salads",
  "Desserts",
  "Beverages",
  "Shakes",
  "Coffee & Tea",
];

// ─── Seed ───────────────────────────────────────────────────────────────────

async function seedMenu() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB\n");

    // 1) Seed categories
    const categoryMap = new Map();
    let sortOrder = 0;
    for (const name of CATEGORIES) {
      const doc = await Category.findOneAndUpdate(
        { name },
        { $set: { name, isActive: true, sortOrder: sortOrder++ } },
        { upsert: true, new: true }
      );
      categoryMap.set(name, doc._id);
    }
    console.log(`✓ Categories seeded: ${CATEGORIES.length}`);

    // 2) Seed products
    let created = 0;
    let updated = 0;

    for (const item of MENU) {
      const categoryId = categoryMap.get(item.category);
      if (!categoryId) {
        console.log(`⚠ Missing category "${item.category}" for product "${item.name}"`);
        continue;
      }

      const filter = { name: item.name, category: categoryId };
      const productData = {
        name: item.name,
        price: item.price,
        costPrice: item.costPrice ?? 0,
        category: categoryId,
        description: item.description ?? "",
        isActive: true,
        isAvailable: true,
      };

      const existing = await Product.findOne(filter);
      if (existing) {
        await Product.updateOne(filter, { $set: productData });
        updated++;
      } else {
        await Product.create(productData);
        created++;
      }
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Products Created : ${created}`);
    console.log(`♻️  Products Updated : ${updated}`);
    console.log(`📦 Total Menu Items : ${MENU.length}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedMenu();
