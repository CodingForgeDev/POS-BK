/**
 * Seed Product.recipeLines (BOM) for every item in seed-menu-data MENU.
 *
 * Prerequisites:
 *   npm run seed:menu
 *   npm run seed:inventory:menu
 *
 * Quantities & inventory names come from seed-recipe-data.js (research-based notes there).
 *
 * Usage:
 *   npm run seed:recipes:menu
 */
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { buildRecipes } = require("./seed-recipe-data");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found. Set it in server/.env or server/.env.local");
  process.exit(1);
}

const RecipeLineSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", required: true },
    quantityPerUnit: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const CategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
  },
  { collection: "categories", timestamps: true }
);

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    recipeLines: { type: [RecipeLineSchema], default: [] },
  },
  /** strict: false — tolerate extra fields from main app Product model */
  { collection: "products", strict: false, timestamps: true }
);

const InventorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: "inventories", timestamps: true }
);

const Category = mongoose.models.RecipeSeedCategory || mongoose.model("RecipeSeedCategory", CategorySchema);
const Product = mongoose.models.RecipeSeedProduct || mongoose.model("RecipeSeedProduct", ProductSchema);
const Inventory = mongoose.models.RecipeSeedInventory || mongoose.model("RecipeSeedInventory", InventorySchema);

function mergeRecipeLines(rows, invByName) {
  /** @type {Map<string, number>} */
  const acc = new Map();
  const missing = [];
  for (const row of rows) {
    const id = invByName.get(row.inventoryName);
    if (!id) {
      missing.push(row.inventoryName);
      continue;
    }
    const key = String(id);
    const q = Number(row.quantityPerUnit);
    if (!Number.isFinite(q) || q <= 0) continue;
    acc.set(key, (acc.get(key) || 0) + q);
  }
  const recipeLines = [...acc.entries()].map(([inventoryItem, quantityPerUnit]) => ({
    inventoryItem: new mongoose.Types.ObjectId(inventoryItem),
    quantityPerUnit,
  }));
  return { recipeLines, missing };
}

async function seedRecipesFromMenu() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB\n");

    const invDocs = await Inventory.find({ isActive: true }).lean();
    const invByName = new Map();
    for (const d of invDocs) {
      invByName.set(d.name, d._id);
    }

    const recipes = buildRecipes();
    let updated = 0;
    let skipped = 0;
    const allMissing = new Set();
    const emptyRecipes = [];

    for (const r of recipes) {
      if (!r.lines.length) {
        emptyRecipes.push(`${r.category} / ${r.name}`);
        continue;
      }

      const cat = await Category.findOne({ name: r.category });
      if (!cat) {
        console.warn(`⚠ Category not found: "${r.category}" (seed menu first)`);
        skipped++;
        continue;
      }

      const product = await Product.findOne({ category: cat._id, name: r.name });
      if (!product) {
        console.warn(`⚠ Product not found: "${r.name}" in ${r.category}`);
        skipped++;
        continue;
      }

      const { recipeLines, missing } = mergeRecipeLines(r.lines, invByName);
      missing.forEach((m) => allMissing.add(m));

      if (missing.length) {
        console.warn(`⚠ ${r.name}: missing inventory → ${missing.join(", ")}`);
      }

      if (!recipeLines.length) {
        skipped++;
        continue;
      }

      await Product.updateOne({ _id: product._id }, { $set: { recipeLines } });
      updated++;
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Products updated with recipeLines: ${updated}`);
    if (skipped) console.log(`⏭ Skipped / not found: ${skipped}`);
    if (emptyRecipes.length) {
      console.log(`⚠ Empty recipe definitions: ${emptyRecipes.length}`);
      emptyRecipes.slice(0, 10).forEach((x) => console.log(`   - ${x}`));
    }
    if (allMissing.size) {
      console.log(`\n⚠ Missing inventory names (add to seed-inventory-from-menu or DB):`);
      [...allMissing].sort().forEach((x) => console.log(`   - ${x}`));
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedRecipesFromMenu();
