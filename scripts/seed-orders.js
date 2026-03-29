/**
 * Seeds sample orders across March (current year) with mixed statuses & types.
 * Usage: npm run seed:orders
 *
 * Requires: MongoDB + products in DB (run npm run seed:menu first).
 * Idempotent: deletes only orders whose orderNumber starts with "SEED-ORD-".
 * Loads .env.local then .env (same as server/src/lib/env.ts).
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

const SEED_YEAR = process.env.SEED_ORDER_YEAR
  ? parseInt(process.env.SEED_ORDER_YEAR, 10)
  : new Date().getFullYear();

/** March = month index 2 */
function atMarchDay(day, hour, minute) {
  return new Date(SEED_YEAR, 2, day, hour, minute, 0, 0);
}

function computeOrderFinancials({ subtotal, orderType, serviceChargePercent, gstRatePct }) {
  const discountAmount = 0;
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  const pct = Math.max(0, Math.min(100, serviceChargePercent || 0));
  const serviceChargeAmount =
    orderType === "dine-in" && pct > 0 ? (afterDiscount * pct) / 100 : 0;
  const taxableBase = afterDiscount + serviceChargeAmount;
  const rate = Math.max(0, Math.min(100, gstRatePct || 0));
  const taxAmount = (taxableBase * rate) / 100;
  const total = taxableBase + taxAmount;
  return { subtotal, discountAmount, serviceChargeAmount, taxAmount, total };
}

const OrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    notes: { type: String, default: "" },
    subtotal: { type: Number, required: true },
    isAddOn: { type: Boolean, default: false },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    type: { type: String, enum: ["dine-in", "takeaway", "delivery"], required: true },
    status: {
      type: String,
      enum: ["open", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"],
      default: "open",
    },
    items: [OrderItemSchema],
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    customerName: { type: String, default: "Walk-in" },
    tableNumber: { type: String, default: "" },
    subtotal: { type: Number, required: true },
    taxAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    serviceChargeAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    notes: { type: String, default: "" },
    servedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    kotPrinted: { type: Boolean, default: false },
    kotPrintedAt: { type: Date },
    promisedPrepMinutes: { type: Number, default: null },
    preparingStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const ProductSchema = new mongoose.Schema(
  {
    name: String,
    price: Number,
    isActive: { type: Boolean, default: true },
  },
  { strict: false }
);

const UserSchema = new mongoose.Schema(
  { name: String, email: String, role: String, isActive: { type: Boolean, default: true } },
  { strict: false }
);

const Order = mongoose.models.Order || mongoose.model("Order", OrderSchema);
const Product = mongoose.models.Product || mongoose.model("Product", ProductSchema);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

const GST_PCT = 10;
const DINE_IN_SERVICE_PCT = 5;

function makeItems(products, startIdx, count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const p = products[(startIdx + i) % products.length];
    const qty = 1 + (i % 2);
    items.push({
      product: p._id,
      name: p.name,
      price: p.price,
      quantity: qty,
      notes: i === 0 ? "" : "",
      subtotal: Math.round(p.price * qty * 100) / 100,
    });
  }
  return items;
}

function itemsSubtotal(items) {
  return Math.round(items.reduce((s, it) => s + it.subtotal, 0) * 100) / 100;
}

/**
 * Each row: day (1–31 March), time, status, type, itemCount, customerName, table?, extras
 */
const RAW = [
  { d: 1, h: 9, m: 20, status: "completed", type: "takeaway", items: 2, name: "Walk-in", kot: true },
  { d: 2, h: 11, m: 5, status: "completed", type: "dine-in", items: 3, name: "Ahmad", table: "T3", kot: true },
  { d: 3, h: 12, m: 40, status: "completed", type: "delivery", items: 2, name: "Sara Khan" },
  { d: 3, h: 18, m: 15, status: "completed", type: "takeaway", items: 4, name: "Walk-in", kot: true },
  { d: 4, h: 10, m: 0, status: "open", type: "dine-in", items: 2, name: "Walk-in", table: "T1" },
  { d: 4, h: 14, m: 30, status: "open", type: "takeaway", items: 1, name: "Hassan" },
  { d: 5, h: 13, m: 10, status: "completed", type: "dine-in", items: 3, name: "Family Iqbal", table: "T7", kot: true },
  { d: 6, h: 8, m: 45, status: "completed", type: "takeaway", items: 2, name: "Walk-in" },
  { d: 7, h: 15, m: 22, status: "completed", type: "delivery", items: 3, name: "Usman Traders" },
  { d: 8, h: 19, m: 5, status: "completed", type: "dine-in", items: 4, name: "Zainab", table: "T2", kot: true },
  { d: 9, h: 11, m: 50, status: "accepted", type: "takeaway", items: 2, name: "Walk-in" },
  { d: 10, h: 12, m: 0, status: "completed", type: "takeaway", items: 3, name: "Bilal" },
  { d: 11, h: 16, m: 35, status: "completed", type: "dine-in", items: 2, name: "Office Lunch", table: "T5", kot: true },
  { d: 12, h: 10, m: 15, status: "completed", type: "delivery", items: 2, name: "Nida" },
  { d: 13, h: 14, m: 0, status: "accepted", type: "dine-in", items: 3, name: "Walk-in", table: "T4" },
  { d: 14, h: 20, m: 10, status: "completed", type: "takeaway", items: 5, name: "Walk-in", kot: true },
  { d: 15, h: 9, m: 30, status: "completed", type: "takeaway", items: 2, name: "Farhan" },
  { d: 16, h: 13, m: 45, status: "preparing", type: "takeaway", items: 3, name: "Walk-in", prep: true, kot: true },
  { d: 17, h: 17, m: 20, status: "completed", type: "dine-in", items: 2, name: "Couple — Table 8", table: "T8", kot: true },
  { d: 18, h: 12, m: 30, status: "completed", type: "delivery", items: 4, name: "Hostel Block C" },
  { d: 19, h: 18, m: 50, status: "completed", type: "takeaway", items: 2, name: "Walk-in" },
  { d: 20, h: 11, m: 10, status: "ready", type: "takeaway", items: 2, name: "Imran", kot: true },
  { d: 21, h: 15, m: 5, status: "completed", type: "dine-in", items: 3, name: "Birthday — Ayesha", table: "T6", kot: true },
  { d: 22, h: 19, m: 40, status: "completed", type: "takeaway", items: 3, name: "Walk-in" },
  { d: 23, h: 10, m: 5, status: "rejected", type: "delivery", items: 1, name: "Spam test", notes: "Rejected — invalid address" },
  { d: 24, h: 14, m: 25, status: "completed", type: "takeaway", items: 2, name: "Kamran" },
  { d: 25, h: 12, m: 15, status: "completed", type: "dine-in", items: 4, name: "Walk-in", table: "T1", kot: true },
  { d: 26, h: 16, m: 0, status: "completed", type: "delivery", items: 2, name: "Rabia" },
  { d: 27, h: 9, m: 50, status: "cancelled", type: "takeaway", items: 2, name: "Walk-in", notes: "Customer cancelled" },
  { d: 28, h: 20, m: 30, status: "completed", type: "takeaway", items: 3, name: "Late order", kot: true },

  /* Late March — includes 29th so “today” (e.g. 29 Mar 2026) shows data on Orders default date */
  { d: 29, h: 8, m: 30, status: "completed", type: "takeaway", items: 2, name: "Walk-in", kot: true },
  { d: 29, h: 11, m: 0, status: "completed", type: "dine-in", items: 3, name: "March close — office", table: "T2", kot: true },
  { d: 29, h: 13, m: 20, status: "open", type: "takeaway", items: 2, name: "Walk-in" },
  { d: 29, h: 14, m: 45, status: "open", type: "dine-in", items: 2, name: "Walk-in", table: "T9" },
  { d: 29, h: 16, m: 10, status: "accepted", type: "delivery", items: 3, name: "Hina Malik" },
  { d: 29, h: 18, m: 0, status: "preparing", type: "takeaway", items: 2, name: "Walk-in", prep: true, kot: true },
  { d: 29, h: 19, m: 30, status: "ready", type: "takeaway", items: 2, name: "Rush pickup", kot: true },
  { d: 29, h: 21, m: 15, status: "completed", type: "takeaway", items: 2, name: "Walk-in", kot: true },

  { d: 30, h: 9, m: 15, status: "completed", type: "delivery", items: 2, name: "Weekend order" },
  { d: 30, h: 14, m: 0, status: "completed", type: "dine-in", items: 4, name: "Family dinner", table: "T5", kot: true },
  { d: 30, h: 17, m: 40, status: "accepted", type: "takeaway", items: 2, name: "Walk-in" },

  { d: 31, h: 10, m: 30, status: "completed", type: "takeaway", items: 3, name: "Month-end stock-up" },
  { d: 31, h: 15, m: 0, status: "open", type: "dine-in", items: 2, name: "Walk-in", table: "T1" },
  { d: 31, h: 20, m: 0, status: "completed", type: "takeaway", items: 2, name: "Walk-in", kot: true },
];

async function seedOrders() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB");

    const products = await Product.find({ isActive: true }).sort({ name: 1 }).lean();
    if (!products.length) {
      console.error("❌ No products found. Run: npm run seed:menu");
      process.exit(1);
    }

    let servedBy = await User.findOne({ isActive: true }).sort({ createdAt: 1 }).select("_id").lean();
    if (!servedBy) {
      servedBy = await User.findOne().sort({ createdAt: 1 }).select("_id").lean();
    }
    if (!servedBy) console.warn("⚠ No user in DB — servedBy will be omitted");

    const del = await Order.deleteMany({ orderNumber: { $regex: /^SEED-ORD-/ } });
    if (del.deletedCount) console.log(`✓ Removed ${del.deletedCount} previous seed orders`);

    const docs = [];
    let seq = 1;
    for (let i = 0; i < RAW.length; i++) {
      const row = RAW[i];
      const createdAt = atMarchDay(row.d, row.h, row.m);
      const items = makeItems(products, i * 2, row.items);
      const subtotal = itemsSubtotal(items);
      const fin = computeOrderFinancials({
        subtotal,
        orderType: row.type,
        serviceChargePercent: DINE_IN_SERVICE_PCT,
        gstRatePct: GST_PCT,
      });

      const orderNumber = `SEED-ORD-${SEED_YEAR}03${String(row.d).padStart(2, "0")}-${String(seq++).padStart(3, "0")}`;

      const doc = {
        orderNumber,
        type: row.type,
        status: row.status,
        items,
        customer: null,
        customerName: row.name,
        tableNumber: row.table || "",
        subtotal: fin.subtotal,
        taxAmount: Math.round(fin.taxAmount * 100) / 100,
        discountAmount: fin.discountAmount,
        serviceChargeAmount: Math.round(fin.serviceChargeAmount * 100) / 100,
        total: Math.round(fin.total * 100) / 100,
        notes: row.notes || "",
        kotPrinted: Boolean(row.kot),
        promisedPrepMinutes: row.prep ? 25 : null,
        createdAt,
        updatedAt: createdAt,
      };
      if (servedBy?._id) doc.servedBy = servedBy._id;
      if (row.kot) doc.kotPrintedAt = createdAt;
      if (row.prep) doc.preparingStartedAt = new Date(createdAt.getTime() + 2 * 60 * 1000);
      docs.push(doc);
    }

    await Order.insertMany(docs);
    const completed = RAW.filter((r) => r.status === "completed").length;
    console.log(`\n✅ Inserted ${docs.length} orders for March ${SEED_YEAR}`);
    console.log(`   (${completed} completed, plus open / accepted / preparing / ready / rejected / cancelled)\n`);

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedOrders();
