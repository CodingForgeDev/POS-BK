/**
 * One-time (idempotent): for each active inventory row with currentStock > 0 and no StockLayer docs,
 * inserts a single opening layer so FIFO billing can consume stock.
 *
 * Usage: npx tsx scripts/backfill-stock-layers-from-inventory.ts
 */

import mongoose from "mongoose";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env") });

import Inventory from "../src/models/Inventory";
import StockLayer from "../src/models/StockLayer";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const items = await Inventory.find({ isActive: true, currentStock: { $gt: 0 } }).lean();
  let created = 0;
  let skipped = 0;

  for (const inv of items) {
    const exists = await StockLayer.exists({ inventoryItem: inv._id });
    if (exists) {
      skipped++;
      continue;
    }
    const qty = Number(inv.currentStock) || 0;
    if (!(qty > 0)) continue;
    const receivedAt = inv.lastRestockedAt || inv.createdAt || new Date();
    const unitCost = Math.max(0, Number(inv.costPerUnit) || 0);

    await StockLayer.create({
      sourceType: "opening",
      purchase: null,
      lineIndex: 0,
      inventoryItem: inv._id,
      supplier: inv.supplier || null,
      receivedAt,
      quantityOriginal: qty,
      quantityRemaining: qty,
      unitCost,
    });
    created++;
    console.log(`Opening layer: ${inv.name} × ${qty} @ ${unitCost}`);
  }

  console.log(`Done. Created ${created} opening layers, skipped ${skipped} items (already had layers).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
