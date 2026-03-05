/**
 * Seeds a complete fast-food restaurant menu: Categories + Products
 * Usage: node scripts/seed-menu.js  (or: npm run seed:menu)
 *
 * Notes:
 * - Loads .env.local for MONGODB_URI
 * - Idempotent (upsert by name + category)
 * - Prices are in PKR
 * - Matches existing Category & Product schemas (price, not sellingPrice)
 */

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// Load .env.local
const envPath = path.join(__dirname, "../.env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] = rest.join("=").trim();
  }
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found in .env.local");
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

const MENU = [
  // ── Burgers ───────────────────────────────────────────────────────────────
  { category: "Burgers", name: "Classic Beef Burger", price: 699, costPrice: 380, description: "Juicy beef patty, lettuce, onions, pickles, house sauce." },
  { category: "Burgers", name: "Cheese Beef Burger", price: 799, costPrice: 430, description: "Beef patty, cheddar cheese, caramelized onions, house sauce." },
  { category: "Burgers", name: "Double Cheese Beef Burger", price: 1099, costPrice: 620, description: "Two beef patties, double cheese, pickles, signature sauce." },
  { category: "Burgers", name: "Mushroom Swiss Beef Burger", price: 999, costPrice: 560, description: "Sautéed mushrooms, swiss cheese, creamy garlic mayo." },
  { category: "Burgers", name: "BBQ Beef Burger", price: 949, costPrice: 530, description: "Smoky BBQ glaze, crispy onion rings, cheddar, mayo." },
  { category: "Burgers", name: "Spicy Jalapeño Beef Burger", price: 949, costPrice: 520, description: "Jalapeños, pepper jack, spicy mayo, fresh lettuce." },

  // ── Chicken Burgers ───────────────────────────────────────────────────────
  { category: "Chicken Burgers", name: "Classic Crispy Chicken Burger", price: 649, costPrice: 360, description: "Crispy chicken fillet, lettuce, mayo, pickles." },
  { category: "Chicken Burgers", name: "Spicy Crispy Chicken Burger", price: 699, costPrice: 390, description: "Crispy fillet, spicy sauce, jalapeños, slaw." },
  { category: "Chicken Burgers", name: "Chicken Cheese Burger", price: 749, costPrice: 420, description: "Crispy fillet, cheddar, house sauce, pickles." },
  { category: "Chicken Burgers", name: "Grilled Chicken Burger", price: 799, costPrice: 450, description: "Grilled chicken, lettuce, tomatoes, herb mayo." },
  { category: "Chicken Burgers", name: "Nashville Hot Chicken Burger", price: 899, costPrice: 520, description: "Hot glazed fillet, slaw, pickles, spicy mayo." },

  // ── Pizza ─────────────────────────────────────────────────────────────────
  { category: "Pizza", name: "Margherita Pizza (Personal)", price: 899, costPrice: 520, description: "Classic tomato sauce, mozzarella, basil." },
  { category: "Pizza", name: "Margherita Pizza (Regular)", price: 1599, costPrice: 980, description: "Classic tomato sauce, mozzarella, basil." },
  { category: "Pizza", name: "Margherita Pizza (Large)", price: 2299, costPrice: 1450, description: "Classic tomato sauce, mozzarella, basil." },
  { category: "Pizza", name: "Pepperoni Pizza (Personal)", price: 999, costPrice: 600, description: "Pepperoni, mozzarella, oregano, tomato sauce." },
  { category: "Pizza", name: "Pepperoni Pizza (Regular)", price: 1799, costPrice: 1120, description: "Pepperoni, mozzarella, oregano, tomato sauce." },
  { category: "Pizza", name: "Pepperoni Pizza (Large)", price: 2599, costPrice: 1650, description: "Pepperoni, mozzarella, oregano, tomato sauce." },
  { category: "Pizza", name: "BBQ Chicken Pizza (Personal)", price: 1099, costPrice: 680, description: "BBQ sauce, grilled chicken, onions, mozzarella." },
  { category: "Pizza", name: "BBQ Chicken Pizza (Regular)", price: 1999, costPrice: 1280, description: "BBQ sauce, grilled chicken, onions, mozzarella." },
  { category: "Pizza", name: "BBQ Chicken Pizza (Large)", price: 2899, costPrice: 1880, description: "BBQ sauce, grilled chicken, onions, mozzarella." },
  { category: "Pizza", name: "Fajita Pizza (Personal)", price: 1099, costPrice: 690, description: "Chicken fajita, capsicum, onions, spicy sauce." },
  { category: "Pizza", name: "Fajita Pizza (Regular)", price: 1999, costPrice: 1290, description: "Chicken fajita, capsicum, onions, spicy sauce." },
  { category: "Pizza", name: "Fajita Pizza (Large)", price: 2899, costPrice: 1890, description: "Chicken fajita, capsicum, onions, spicy sauce." },
  { category: "Pizza", name: "Veggie Supreme Pizza (Personal)", price: 999, costPrice: 610, description: "Mushrooms, olives, onions, capsicum, mozzarella." },
  { category: "Pizza", name: "Veggie Supreme Pizza (Regular)", price: 1799, costPrice: 1140, description: "Mushrooms, olives, onions, capsicum, mozzarella." },
  { category: "Pizza", name: "Veggie Supreme Pizza (Large)", price: 2599, costPrice: 1670, description: "Mushrooms, olives, onions, capsicum, mozzarella." },

  // ── Sandwiches & Subs ─────────────────────────────────────────────────────
  { category: "Sandwiches & Subs", name: "Chicken Club Sandwich", price: 799, costPrice: 450, description: "Chicken, egg, lettuce, tomatoes, mayo, toasted bread." },
  { category: "Sandwiches & Subs", name: "BBQ Chicken Sub (6 inch)", price: 699, costPrice: 390, description: "BBQ chicken, cheese, onions, jalapeño, sauce." },
  { category: "Sandwiches & Subs", name: "BBQ Chicken Sub (12 inch)", price: 1199, costPrice: 690, description: "BBQ chicken, cheese, onions, jalapeño, sauce." },
  { category: "Sandwiches & Subs", name: "Beef Steak Sandwich", price: 999, costPrice: 580, description: "Sliced beef, sautéed onions, cheese, creamy sauce." },

  // ── Wraps ────────────────────────────────────────────────────────────────
  { category: "Wraps", name: "Crispy Chicken Wrap", price: 649, costPrice: 360, description: "Crispy chicken strips, lettuce, mayo, tortilla." },
  { category: "Wraps", name: "Spicy Chicken Wrap", price: 699, costPrice: 390, description: "Spicy chicken, slaw, jalapeños, hot sauce." },
  { category: "Wraps", name: "Grilled Chicken Wrap", price: 749, costPrice: 420, description: "Grilled chicken, veggies, herb mayo, tortilla." },

  // ── Fried Chicken ─────────────────────────────────────────────────────────
  { category: "Fried Chicken", name: "Fried Chicken (2 pcs)", price: 599, costPrice: 340, description: "Crispy fried chicken pieces with seasoning." },
  { category: "Fried Chicken", name: "Fried Chicken (4 pcs)", price: 1099, costPrice: 640, description: "Crispy fried chicken pieces with seasoning." },
  { category: "Fried Chicken", name: "Fried Chicken (8 pcs)", price: 1999, costPrice: 1250, description: "Family bucket - crispy fried chicken." },

  // ── Wings ─────────────────────────────────────────────────────────────────
  { category: "Wings", name: "Baked Wings (6 pcs)", price: 699, costPrice: 400, description: "Oven-baked wings, lightly crisped, sauce of choice." },
  { category: "Wings", name: "Baked Wings (12 pcs)", price: 1299, costPrice: 780, description: "Oven-baked wings, lightly crisped, sauce of choice." },
  { category: "Wings", name: "Crispy Fried Wings (6 pcs)", price: 749, costPrice: 440, description: "Crunchy wings tossed in your favorite sauce." },
  { category: "Wings", name: "Crispy Fried Wings (12 pcs)", price: 1399, costPrice: 840, description: "Crunchy wings tossed in your favorite sauce." },

  // ── Sides ────────────────────────────────────────────────────────────────
  { category: "Sides", name: "French Fries (Regular)", price: 249, costPrice: 120, description: "Golden crispy fries with seasoning." },
  { category: "Sides", name: "French Fries (Large)", price: 349, costPrice: 170, description: "Large portion of golden crispy fries." },
  { category: "Sides", name: "Loaded Fries", price: 499, costPrice: 280, description: "Fries topped with cheese sauce, jalapeños, chicken bits." },
  { category: "Sides", name: "Onion Rings", price: 399, costPrice: 220, description: "Crispy battered onion rings." },
  { category: "Sides", name: "Chicken Nuggets (6 pcs)", price: 449, costPrice: 240, description: "Tender nuggets with dip." },
  { category: "Sides", name: "Chicken Nuggets (12 pcs)", price: 799, costPrice: 460, description: "12 nuggets with dips." },
  { category: "Sides", name: "Garlic Bread (4 pcs)", price: 299, costPrice: 150, description: "Toasted garlic bread with herbs." },
  { category: "Sides", name: "Mozzarella Sticks (6 pcs)", price: 599, costPrice: 360, description: "Cheesy mozzarella sticks with marinara." },
  { category: "Sides", name: "Coleslaw", price: 199, costPrice: 90, description: "Creamy crunchy coleslaw." },

  // ── Sauces & Dips ─────────────────────────────────────────────────────────
  { category: "Sauces & Dips", name: "Garlic Mayo Dip", price: 80, costPrice: 20, description: "Creamy garlic mayo dip." },
  { category: "Sauces & Dips", name: "Spicy Mayo Dip", price: 80, costPrice: 20, description: "Mayo with spicy kick." },
  { category: "Sauces & Dips", name: "BBQ Dip", price: 80, costPrice: 18, description: "Smoky BBQ dip." },
  { category: "Sauces & Dips", name: "Honey Mustard Dip", price: 90, costPrice: 22, description: "Sweet & tangy honey mustard." },
  { category: "Sauces & Dips", name: "Ranch Dip", price: 90, costPrice: 22, description: "Classic ranch dip." },
  { category: "Sauces & Dips", name: "Hot Sauce Dip", price: 70, costPrice: 15, description: "Hot chili sauce." },
  { category: "Sauces & Dips", name: "Cheese Sauce Dip", price: 120, costPrice: 45, description: "Warm cheese sauce." },

  // ── Salads ────────────────────────────────────────────────────────────────
  { category: "Salads", name: "Chicken Caesar Salad", price: 799, costPrice: 460, description: "Romaine, grilled chicken, croutons, parmesan, caesar dressing." },
  { category: "Salads", name: "Garden Salad", price: 499, costPrice: 260, description: "Fresh veggies, olives, light dressing." },

  // ── Desserts ──────────────────────────────────────────────────────────────
  { category: "Desserts", name: "Chocolate Brownie", price: 299, costPrice: 140, description: "Warm brownie, rich cocoa flavor." },
  { category: "Desserts", name: "Molten Lava Cake", price: 399, costPrice: 190, description: "Soft cake with molten chocolate center." },
  { category: "Desserts", name: "Cheesecake Slice", price: 449, costPrice: 240, description: "Creamy cheesecake slice." },
  { category: "Desserts", name: "Ice Cream Cup", price: 199, costPrice: 80, description: "Vanilla ice cream cup." },

  // ── Beverages ─────────────────────────────────────────────────────────────
  { category: "Beverages", name: "Mineral Water (500ml)", price: 80, costPrice: 30, description: "Chilled mineral water." },
  { category: "Beverages", name: "Soft Drink (Can)", price: 150, costPrice: 90, description: "Assorted flavors (can)." },
  { category: "Beverages", name: "Soft Drink (500ml)", price: 180, costPrice: 110, description: "Assorted flavors (bottle)." },
  { category: "Beverages", name: "Fresh Lime", price: 199, costPrice: 70, description: "Fresh lime soda (sweet/salt)." },
  { category: "Beverages", name: "Mint Lemonade", price: 249, costPrice: 90, description: "Refreshing mint lemonade." },
  { category: "Beverages", name: "Iced Tea (Peach)", price: 249, costPrice: 90, description: "Peach flavored iced tea." },
  { category: "Beverages", name: "Iced Tea (Lemon)", price: 249, costPrice: 90, description: "Lemon flavored iced tea." },

  // ── Shakes ────────────────────────────────────────────────────────────────
  { category: "Shakes", name: "Chocolate Shake", price: 399, costPrice: 190, description: "Creamy chocolate shake." },
  { category: "Shakes", name: "Vanilla Shake", price: 399, costPrice: 190, description: "Classic vanilla shake." },
  { category: "Shakes", name: "Strawberry Shake", price: 399, costPrice: 190, description: "Strawberry shake with real flavor." },
  { category: "Shakes", name: "Oreo Shake", price: 449, costPrice: 220, description: "Cookies & cream shake." },

  // ── Coffee & Tea ──────────────────────────────────────────────────────────
  { category: "Coffee & Tea", name: "Espresso", price: 249, costPrice: 90, description: "Single shot espresso." },
  { category: "Coffee & Tea", name: "Americano", price: 299, costPrice: 110, description: "Espresso with hot water." },
  { category: "Coffee & Tea", name: "Cappuccino", price: 349, costPrice: 140, description: "Espresso with steamed milk foam." },
  { category: "Coffee & Tea", name: "Latte", price: 349, costPrice: 150, description: "Smooth espresso with steamed milk." },
  { category: "Coffee & Tea", name: "Karak Chai", price: 149, costPrice: 60, description: "Traditional strong milk tea." },
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
