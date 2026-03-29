/**
 * Creates Invoice documents for completed SEED-ORD-* orders so Dashboard / Reports show revenue.
 * Usage: npm run seed:invoices
 *
 * - Loads .env.local then .env
 * - Idempotent: removes invoices with invoiceNumber /^SEED-INV-/
 * - Only targets orders: orderNumber /^SEED-ORD-/ AND status === "completed"
 * - Invoice amounts mirror the order (same as real billing output)
 * - createdAt / updatedAt = order.createdAt (reports filter by invoice date)
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

const OrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    notes: { type: String, default: "" },
    subtotal: { type: Number, required: true },
    isAddOn: { type: Boolean, default: false },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: String,
    status: String,
    items: [OrderItemSchema],
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    customerName: String,
    subtotal: Number,
    taxAmount: Number,
    discountAmount: Number,
    serviceChargeAmount: Number,
    total: Number,
  },
  { timestamps: true, strict: false }
);

const InvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    customerName: { type: String, default: "Walk-in" },
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        subtotal: { type: Number, required: true },
        _id: false,
      },
    ],
    subtotal: { type: Number, required: true },
    taxRate: { type: Number, default: 10 },
    taxAmount: { type: Number, default: 0 },
    discountType: { type: String, enum: ["percentage", "fixed", "none"], default: "none" },
    discountValue: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    serviceChargeAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "debit_card", "credit_card", "gsb_card", "digital", "split"],
      required: true,
    },
    amountPaid: { type: Number, required: true },
    changeGiven: { type: Number, default: 0 },
    status: { type: String, enum: ["paid", "refunded", "partial"], default: "paid" },
    notes: { type: String, default: "" },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const Order = mongoose.models.Order || mongoose.model("Order", OrderSchema);
const Invoice = mongoose.models.Invoice || mongoose.model("Invoice", InvoiceSchema);
const User = mongoose.models.User || mongoose.model(
  "User",
  new mongoose.Schema({ name: String, email: String, role: String, isActive: Boolean }, { strict: false })
);

const PAYMENT_ROTATION = ["cash", "card", "digital", "cash", "debit_card", "digital", "card"];

function taxRateFromOrder(order) {
  const discount = Number(order.discountAmount) || 0;
  const service = Number(order.serviceChargeAmount) || 0;
  const sub = Number(order.subtotal) || 0;
  const taxableBase = Math.max(0, sub - discount + service);
  const tax = Number(order.taxAmount) || 0;
  if (taxableBase <= 0) return 10;
  const pct = (tax / taxableBase) * 100;
  return Math.round(pct * 100) / 100;
}

function discountTypeFromOrder(order) {
  const d = Number(order.discountAmount) || 0;
  if (d <= 0) return "none";
  return "fixed";
}

async function seedInvoices() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB");

    const removed = await Invoice.deleteMany({ invoiceNumber: { $regex: /^SEED-INV-/ } });
    if (removed.deletedCount) console.log(`✓ Removed ${removed.deletedCount} previous SEED-INV invoices`);

    let issuedBy = await User.findOne({ isActive: true }).sort({ createdAt: 1 }).select("_id").lean();
    if (!issuedBy) issuedBy = await User.findOne().sort({ createdAt: 1 }).select("_id").lean();

    const orders = await Order.find({
      orderNumber: { $regex: /^SEED-ORD-/ },
      status: "completed",
    })
      .sort({ createdAt: 1 })
      .lean();

    if (!orders.length) {
      console.error("❌ No completed SEED-ORD orders found. Run: npm run seed:orders");
      process.exit(1);
    }

    const docs = [];
    let seq = 1;
    for (const order of orders) {
      const items = (order.items || []).map((it) => ({
        name: it.name,
        quantity: it.quantity,
        price: it.price,
        subtotal: it.subtotal,
      }));

      const subtotal = Number(order.subtotal) || 0;
      const discountAmount = Number(order.discountAmount) || 0;
      const serviceChargeAmount = Number(order.serviceChargeAmount) || 0;
      const taxAmount = Number(order.taxAmount) || 0;
      const total = Number(order.total) || 0;
      const taxRate = taxRateFromOrder(order);
      const paymentMethod = PAYMENT_ROTATION[(seq - 1) % PAYMENT_ROTATION.length];
      const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
      const invoiceNumber = `SEED-INV-${String(seq).padStart(5, "0")}`;

      const doc = {
        invoiceNumber,
        order: order._id,
        customer: order.customer || null,
        customerName: order.customerName || "Walk-in",
        items,
        subtotal,
        taxRate,
        taxAmount,
        discountType: discountTypeFromOrder(order),
        discountValue: discountAmount > 0 ? discountAmount : 0,
        discountAmount,
        serviceChargeAmount,
        total,
        paymentMethod,
        amountPaid: total,
        changeGiven: 0,
        status: "paid",
        notes: "",
        createdAt,
        updatedAt: createdAt,
      };
      if (issuedBy?._id) doc.issuedBy = issuedBy._id;
      docs.push(doc);
      seq++;
    }

    await Invoice.insertMany(docs);
    console.log(`\n✅ Created ${docs.length} invoices linked to completed seed orders`);
    console.log("   Dashboard & Reports revenue should reflect these for matching dates/periods.\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedInvoices();
