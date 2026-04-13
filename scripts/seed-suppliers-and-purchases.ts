/**
 * Seeds demo suppliers and purchase receipts (creates Purchase + StockLayer + inventory updates).
 *
 * Usage: npm run seed:suppliers-purchases
 *
 * Prerequisites:
 * - MONGODB_URI in server/.env or .env.local
 * - At least one User (e.g. npm run seed:admin)
 * - At least 2 active Inventory rows (e.g. npm run seed:inventory:menu)
 * - MongoDB replica set / Atlas (transactions), same as POST /api/purchases
 *
 * Idempotent: skips suppliers that already exist by name; skips purchases whose referenceNumber matches.
 */

import mongoose from "mongoose";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env") });

import User from "../src/models/User";
import Supplier from "../src/models/Supplier";
import Inventory from "../src/models/Inventory";
import Purchase from "../src/models/Purchase";
import { postPurchaseInSession } from "../src/lib/purchasePosting";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not set (server/.env or .env.local)");
  process.exit(1);
}

const SEED_SUPPLIERS = [
  {
    name: "Fresh Dairy Supplies",
    contactPerson: "Sara Malik",
    phone: "+92-300-1112233",
    email: "orders@freshdairy.example",
    address: "Industrial Area, Block C",
    supplyCategory: "Dairy",
    paymentTerms: "Net 15 days",
    notes: "Seeded by seed-suppliers-and-purchases",
  },
  {
    name: "City Produce Traders",
    contactPerson: "Hassan Raza",
    phone: "+92-321-4445566",
    email: "dispatch@cityproduce.example",
    address: "Wholesale Market, Gate 2",
    supplyCategory: "Produce",
    paymentTerms: "Cash on delivery",
    notes: "Seeded by seed-suppliers-and-purchases",
  },
  {
    name: "Cafe Dry Goods Co.",
    contactPerson: "Omar Siddiqui",
    phone: "+92-333-7778899",
    email: "sales@drygoods.example",
    address: "Warehouse Road 12",
    supplyCategory: "Dry goods",
    paymentTerms: "Net 30 days",
    notes: "Seeded by seed-suppliers-and-purchases",
  },
] as const;

const SEED_PURCHASE_REFS = ["SEED-PUR-001", "SEED-PUR-002", "SEED-PUR-003"] as const;

async function ensureSupplier(doc: (typeof SEED_SUPPLIERS)[number]) {
  const existing = await Supplier.findOne({ name: doc.name }).lean();
  if (existing) {
    console.log(`  Supplier exists: ${doc.name}`);
    return existing;
  }
  const created = await Supplier.create({ ...doc, isActive: true });
  console.log(`  Created supplier: ${doc.name}`);
  return created.toObject();
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB\n");

  const user =
    (await User.findOne({ role: "admin", isActive: true }).lean()) ||
    (await User.findOne({ isActive: true }).lean());
  if (!user?._id) {
    console.error("No active user found. Run: npm run seed:admin");
    await mongoose.disconnect();
    process.exit(1);
  }
  const userId = String(user._id);
  console.log(`Using user: ${user.name || userId} (${user.role})\n`);

  console.log("Suppliers:");
  const byName = new Map<string, { _id: mongoose.Types.ObjectId }>();
  for (const s of SEED_SUPPLIERS) {
    const row = await ensureSupplier(s);
    byName.set(s.name, { _id: new mongoose.Types.ObjectId(String(row._id)) });
  }

  const invItems = await Inventory.find({ isActive: true }).sort({ name: 1 }).limit(12).lean();
  if (invItems.length < 2) {
    console.error("\nNeed at least 2 active inventory items. Run: npm run seed:inventory:menu");
    await mongoose.disconnect();
    process.exit(1);
  }

  const pick = (i: number) => String(invItems[i % invItems.length]._id);

  const purchasePlans: Array<{
    ref: string;
    supplierName: string;
    daysAgo: number;
    lines: { idx: number; qty: number; unitCost: number }[];
    notes: string;
  }> = [
    {
      ref: SEED_PURCHASE_REFS[0],
      supplierName: "Fresh Dairy Supplies",
      daysAgo: 5,
      lines: [
        { idx: 0, qty: 24, unitCost: 180 },
        { idx: 1, qty: 12, unitCost: 95 },
      ],
      notes: "Morning delivery — seeded",
    },
    {
      ref: SEED_PURCHASE_REFS[1],
      supplierName: "City Produce Traders",
      daysAgo: 3,
      lines: [
        { idx: 2, qty: 18, unitCost: 120 },
        { idx: 3, qty: 30, unitCost: 45 },
      ],
      notes: "Weekly produce — seeded",
    },
    {
      ref: SEED_PURCHASE_REFS[2],
      supplierName: "Cafe Dry Goods Co.",
      daysAgo: 1,
      lines: [
        { idx: 0, qty: 8, unitCost: 210 },
        { idx: Math.min(4, invItems.length - 1), qty: 15, unitCost: 320 },
      ],
      notes: "Dry stock top-up — seeded",
    },
  ];

  console.log("\nPurchases:");
  for (const plan of purchasePlans) {
    const exists = await Purchase.findOne({ referenceNumber: plan.ref }).lean();
    if (exists) {
      console.log(`  Skip (exists): ${plan.ref}`);
      continue;
    }

    const sup = byName.get(plan.supplierName);
    if (!sup) {
      console.error(`  Missing supplier: ${plan.supplierName}`);
      continue;
    }

    const receivedAt = new Date();
    receivedAt.setDate(receivedAt.getDate() - plan.daysAgo);
    receivedAt.setHours(10, 0, 0, 0);

    const lines = plan.lines.map((l) => ({
      inventoryItem: pick(l.idx),
      quantity: l.qty,
      unitCost: l.unitCost,
    }));

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await postPurchaseInSession(session, {
          supplierId: String(sup._id),
          referenceNumber: plan.ref,
          receivedAt,
          notes: plan.notes,
          lines,
          userId,
        });
      });
      console.log(`  Posted: ${plan.ref} (${plan.supplierName})`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: number })?.code;
      console.error(`  Failed ${plan.ref}:`, msg);
      if (code === 20 || /replica set/i.test(msg)) {
        console.error("  Hint: MongoDB transactions need a replica set (Atlas or mongod --replSet). See server/MONGODB-TRANSACTIONS.md");
      }
    } finally {
      session.endSession();
    }
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
