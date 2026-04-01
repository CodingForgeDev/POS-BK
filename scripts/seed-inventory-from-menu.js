/**
 * Seed Inventory items inferred from the seeded MENU (seed-menu.js).
 *
 * Goal:
 * - Create/Upsert raw inventory rows for ingredients that appear in menu item names/descriptions
 * - Idempotent (upsert by name)
 * - Does NOT try to build per-product recipes; it only ensures "required items exist" in Inventory
 *
 * Usage:
 *   npm run seed:inventory:menu
 */
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { MENU } = require("./seed-menu-data");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found. Set it in server/.env or server/.env.local");
  process.exit(1);
}

// ─── Inventory schema (match server/src/models/Inventory.ts) ──────────────────
const InventorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, unique: true, sparse: true },
    category: { type: String, default: "" },
    unit: { type: String, required: true },
    currentStock: { type: Number, required: true, default: 0 },
    minimumStock: { type: Number, default: 0 },
    maximumStock: { type: Number, default: 1000 },
    costPerUnit: { type: Number, default: 0 },
    wastageAmount: { type: Number, default: 0 },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    supplierName: { type: String, default: "" },
    supplierContact: { type: String, default: "" },
    lastRestockedAt: { type: Date, default: null },
    lastRestockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Inventory = mongoose.models.Inventory || mongoose.model("Inventory", InventorySchema);

// ─── Ingredient keyword mapping ──────────────────────────────────────────────
// Keep this mapping intentionally explicit to avoid seeding junk from free-form text.
// Expand as your real recipes solidify.
const INGREDIENTS = [
  // Proteins
  { keys: ["beef patty", "beef patties", "beef"], name: "Beef Patty", unit: "pcs", category: "protein" },
  { keys: ["chicken fillet", "chicken strips", "grilled chicken", "crispy chicken", "crispy fillet", "chicken"], name: "Chicken", unit: "pcs", category: "protein" },
  { keys: ["wings", "baked wings", "fried wings"], name: "Chicken Wings", unit: "pcs", category: "protein" },
  { keys: ["nuggets"], name: "Chicken Nuggets (Frozen)", unit: "pcs", category: "protein" },
  { keys: ["beef steak", "sliced beef"], name: "Beef Steak Strips", unit: "kg", category: "protein" },
  { keys: ["pepperoni"], name: "Pepperoni", unit: "slices", category: "protein" },
  { keys: ["egg"], name: "Egg", unit: "pcs", category: "protein" },

  // Produce
  { keys: ["lettuce", "romaine"], name: "Lettuce", unit: "leaves", category: "produce" },
  { keys: ["tomato sauce", "tomato"], name: "Tomato", unit: "kg", category: "produce" },
  { keys: ["onion rings", "onions", "onion"], name: "Onion", unit: "kg", category: "produce" },
  { keys: ["jalapeños", "jalapeño", "jalapeno"], name: "Jalapeño", unit: "pcs", category: "produce" },
  { keys: ["mushrooms", "mushroom"], name: "Mushroom", unit: "kg", category: "produce" },
  { keys: ["olives", "olive"], name: "Olives", unit: "kg", category: "produce" },
  { keys: ["capsicum", "bell pepper"], name: "Capsicum", unit: "kg", category: "produce" },
  { keys: ["basil"], name: "Basil", unit: "leaves", category: "produce" },
  { keys: ["mint"], name: "Mint", unit: "leaves", category: "produce" },
  { keys: ["lime"], name: "Lime", unit: "pcs", category: "produce" },
  { keys: ["coleslaw", "slaw"], name: "Cabbage (Slaw)", unit: "kg", category: "produce" },
  { keys: ["fresh veggies", "garden salad", "light dressing"], name: "Mixed Salad Greens", unit: "kg", category: "produce" },

  // Dairy
  { keys: ["mozzarella"], name: "Mozzarella", unit: "kg", category: "dairy" },
  { keys: ["swiss cheese", "swiss"], name: "Swiss Cheese", unit: "kg", category: "dairy" },
  { keys: ["pepper jack"], name: "Pepper Jack Cheese", unit: "kg", category: "dairy" },
  { keys: ["cheddar", "cheese"], name: "Cheese", unit: "kg", category: "dairy" },
  { keys: ["parmesan"], name: "Parmesan", unit: "kg", category: "dairy" },
  { keys: ["milk"], name: "Milk", unit: "L", category: "dairy" },
  { keys: ["garlic bread", "molten lava"], name: "Butter", unit: "kg", category: "dairy" },
  { keys: ["ice cream"], name: "Ice Cream", unit: "pcs", category: "dairy" },

  // Bakery / Dry
  // "bun" rarely appears in MENU copy; "burger" appears on almost every burger line.
  { keys: ["bun", "buns", "burger"], name: "Burger Bun", unit: "pcs", category: "bakery" },
  { keys: ["toasted bread", "bread"], name: "Bread", unit: "pcs", category: "bakery" },
  { keys: ["tortilla"], name: "Tortilla", unit: "pcs", category: "bakery" },
  { keys: ["pizza", "dough"], name: "Pizza Dough", unit: "pcs", category: "bakery" },
  { keys: ["sub (6", "sub (12", "chicken sub"], name: "Sub Roll", unit: "pcs", category: "bakery" },
  { keys: ["croutons"], name: "Croutons", unit: "box", category: "dry" },
  { keys: ["french fries", "loaded fries", "golden crispy fries", "portion of golden"], name: "French Fries (Frozen)", unit: "kg", category: "dry" },
  { keys: ["battered", "breading"], name: "Breading Mix", unit: "kg", category: "dry" },
  { keys: ["with seasoning", "fried chicken pieces"], name: "Fry Seasoning", unit: "kg", category: "dry" },

  // Sauces / Condiments
  { keys: ["mayo", "mayonnaise"], name: "Mayonnaise", unit: "kg", category: "condiment" },
  { keys: ["bbq", "barbecue"], name: "BBQ Sauce", unit: "kg", category: "condiment" },
  { keys: ["ranch"], name: "Ranch Dressing", unit: "kg", category: "condiment" },
  { keys: ["honey mustard", "mustard"], name: "Mustard", unit: "kg", category: "condiment" },
  { keys: ["hot sauce", "spicy sauce", "spicy mayo"], name: "Hot Sauce", unit: "kg", category: "condiment" },
  // Do NOT use bare "sauce" — it matches almost every menu line (tomato/bbq/etc.).
  { keys: ["house sauce", "signature sauce", "creamy sauce", "creamy garlic"], name: "House Sauce", unit: "kg", category: "condiment" },
  { keys: ["caesar dressing"], name: "Caesar Dressing", unit: "kg", category: "condiment" },
  { keys: ["marinara"], name: "Marinara Sauce", unit: "kg", category: "condiment" },
  { keys: ["cheese sauce"], name: "Cheese Sauce (Prepared)", unit: "kg", category: "condiment" },
  { keys: ["pickles"], name: "Pickles", unit: "kg", category: "produce" },
  { keys: ["oregano"], name: "Oregano", unit: "kg", category: "dry" },
  { keys: ["garlic"], name: "Garlic", unit: "kg", category: "produce" },
  { keys: ["with herbs", "herb mayo"], name: "Dried Herbs", unit: "kg", category: "dry" },
  {
    keys: [
      "fried chicken",
      "fried wing",
      "crispy fried",
      "crispy fried wings",
      "chicken nuggets",
      "onion rings",
      "french fries",
      "loaded fries",
      "golden crispy",
    ],
    name: "Cooking Oil",
    unit: "L",
    category: "dry",
  },

  // Desserts / shake bases (for recipe + costing later)
  { keys: ["chocolate brownie", "molten chocolate", "chocolate shake", "rich cocoa"], name: "Chocolate (Dessert)", unit: "kg", category: "dry" },
  { keys: ["brownie"], name: "Brownie Mix", unit: "kg", category: "dry" },
  { keys: ["lava cake", "molten lava"], name: "Cake Mix (Dessert)", unit: "kg", category: "dry" },
  { keys: ["cheesecake"], name: "Cream Cheese", unit: "kg", category: "dairy" },
  { keys: ["vanilla ice cream", "vanilla shake", "classic vanilla"], name: "Vanilla Syrup", unit: "L", category: "beverage" },
  { keys: ["strawberry shake", "strawberry"], name: "Strawberry Syrup", unit: "L", category: "beverage" },
  { keys: ["oreo", "cookies & cream"], name: "Cookie Crumbs", unit: "kg", category: "dry" },

  // Drinks / Retail (keep basic)
  // Avoid bare "water" — it matches "hot water" on Americano.
  { keys: ["mineral water", "chilled mineral", "500ml"], name: "Mineral Water", unit: "bottle", category: "beverage" },
  { keys: ["soft drink"], name: "Soft Drink", unit: "bottle", category: "beverage" },
  { keys: ["americano"], name: "Water (Filtered)", unit: "L", category: "beverage" },
  { keys: ["coffee", "espresso", "cappuccino", "latte"], name: "Coffee Beans", unit: "kg", category: "beverage" },
  { keys: ["tea", "chai"], name: "Tea", unit: "kg", category: "beverage" },
  { keys: ["iced tea"], name: "Iced Tea Base", unit: "L", category: "beverage" },
  { keys: ["peach flavored"], name: "Peach Syrup", unit: "L", category: "beverage" },
  { keys: ["lemon flavored"], name: "Lemon Syrup", unit: "L", category: "beverage" },
  {
    keys: ["sugar", "shake", "karak", "chai", "iced tea", "sweet/", "lemonade", "cheesecake"],
    name: "Sugar",
    unit: "kg",
    category: "dry",
  },
];

/** PKR per unit (matches `unit`: kg, pcs, bottle, etc.) — demo estimates for seeded rows */
const COST_PER_UNIT_PKR = {
  "Beef Patty": 220,
  Chicken: 180,
  "Chicken Wings": 95,
  "Chicken Nuggets (Frozen)": 42,
  "Beef Steak Strips": 980,
  Pepperoni: 25,
  Egg: 28,
  Lettuce: 3,
  Tomato: 120,
  Onion: 160,
  Jalapeño: 12,
  Mushroom: 480,
  Olives: 520,
  Capsicum: 200,
  Basil: 6,
  Mint: 4,
  Lime: 18,
  Mozzarella: 1100,
  "Swiss Cheese": 950,
  "Pepper Jack Cheese": 920,
  Cheese: 900,
  Parmesan: 1500,
  "Cream Cheese": 880,
  Milk: 190,
  Butter: 920,
  "Ice Cream": 130,
  "Burger Bun": 38,
  Bread: 28,
  Tortilla: 22,
  "Pizza Dough": 85,
  "Sub Roll": 45,
  Croutons: 260,
  "French Fries (Frozen)": 320,
  "Breading Mix": 280,
  "Fry Seasoning": 650,
  "Cooking Oil": 420,
  "Chocolate (Dessert)": 1400,
  "Brownie Mix": 520,
  "Cake Mix (Dessert)": 480,
  "Vanilla Syrup": 380,
  "Strawberry Syrup": 390,
  "Cookie Crumbs": 720,
  "Cabbage (Slaw)": 90,
  "Mixed Salad Greens": 140,
  "Marinara Sauce": 340,
  "Cheese Sauce (Prepared)": 520,
  Garlic: 420,
  "Dried Herbs": 1100,
  "Iced Tea Base": 180,
  "Peach Syrup": 260,
  "Lemon Syrup": 240,
  Mayonnaise: 450,
  "BBQ Sauce": 380,
  "Ranch Dressing": 420,
  Mustard: 320,
  "Hot Sauce": 280,
  "House Sauce": 210,
  "Caesar Dressing": 480,
  Pickles: 400,
  Oregano: 820,
  "Mineral Water": 45,
  "Water (Filtered)": 12,
  "Soft Drink": 95,
  "Coffee Beans": 2200,
  Tea: 900,
  Sugar: 150,
};

function defaultCostPerUnit(category) {
  switch (category) {
    case "protein":
      return 150;
    case "produce":
      return 100;
    case "dairy":
      return 200;
    case "bakery":
      return 40;
    case "beverage":
      return 80;
    case "condiment":
      return 280;
    default:
      return 100;
  }
}

function normalize(s) {
  return String(s || "").toLowerCase();
}

function menuText(item) {
  return `${item.name || ""} ${item.description || ""}`.toLowerCase();
}

function extractIngredientNames(items) {
  const found = new Map(); // name -> ingredient spec
  for (const m of items) {
    const text = menuText(m);
    for (const ing of INGREDIENTS) {
      if (ing.keys.some((k) => text.includes(k))) {
        found.set(ing.name, ing);
      }
    }
  }
  return [...found.values()];
}

function defaultsForCategory(cat) {
  // Min/max = reorder band; currentStock = opening on-hand demo (not zero so UI isn’t all 0/0).
  let minimumStock;
  let maximumStock;
  switch (cat) {
    case "protein":
      minimumStock = 10;
      maximumStock = 200;
      break;
    case "produce":
      minimumStock = 2;
      maximumStock = 50;
      break;
    case "dairy":
      minimumStock = 2;
      maximumStock = 50;
      break;
    case "bakery":
      minimumStock = 10;
      maximumStock = 300;
      break;
    case "beverage":
      minimumStock = 20;
      maximumStock = 500;
      break;
    case "condiment":
      minimumStock = 3;
      maximumStock = 80;
      break;
    default:
      minimumStock = 5;
      maximumStock = 200;
  }
  const currentStock = Math.min(Math.max(minimumStock * 2, 8), maximumStock);
  return { minimumStock, maximumStock, currentStock };
}

async function seedInventoryFromMenu() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB\n");

    if (!Array.isArray(MENU) || MENU.length === 0) {
      console.error("❌ MENU not found/empty. Did you run the menu seed or keep seed-menu-data in sync?");
      process.exit(1);
    }

    const inferred = extractIngredientNames(MENU);
    console.log(`✓ Inferred unique inventory ingredients: ${inferred.length}`);

    let created = 0;
    let updated = 0;

    for (const ing of inferred) {
      const base = defaultsForCategory(ing.category);
      const costPerUnit = COST_PER_UNIT_PKR[ing.name] ?? defaultCostPerUnit(ing.category);
      const payload = {
        name: ing.name,
        unit: ing.unit,
        category: ing.category || "",
        isActive: true,
        minimumStock: base.minimumStock,
        maximumStock: base.maximumStock,
        costPerUnit,
        notes: "Seeded from menu keywords (seed-inventory-from-menu.js)",
      };

      const existing = await Inventory.findOne({ name: ing.name });
      if (existing) {
        const setDoc = { ...payload };
        // If stock was never adjusted (still 0), apply demo opening stock so min/current aren’t confusing.
        if (existing.currentStock === 0) {
          setDoc.currentStock = base.currentStock;
        }
        await Inventory.updateOne({ _id: existing._id }, { $set: setDoc });
        updated++;
      } else {
        await Inventory.create({ ...payload, currentStock: base.currentStock });
        created++;
      }
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Inventory Created : ${created}`);
    console.log(`♻️  Inventory Updated : ${updated}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedInventoryFromMenu();

