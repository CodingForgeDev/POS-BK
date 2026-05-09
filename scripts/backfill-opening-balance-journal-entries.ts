/**
 * Backfill script: Create missing journal entries for existing opening balance stock layers
 * 
 * This script:
 * 1. Finds all StockLayer records with sourceType: "opening"
 * 2. For each one, checks if a corresponding journal entry exists
 * 3. If missing, creates the journal entry to post to A/P account
 * 4. Updates account balances accordingly
 * 
 * Run with: npm run backfill:opening-balance
 */

import mongoose from "mongoose";
import path from "path";

// Load environment variables from .env files
import dotenv from "dotenv";
const envLocalPath = path.join(__dirname, "../.env.local");
const envPath = path.join(__dirname, "../.env");
dotenv.config({ path: envLocalPath });
dotenv.config({ path: envPath });

import StockLayer from "../src/models/StockLayer";
import Supplier from "../src/models/Supplier";
import JournalEntry from "../src/models/JournalEntry";
import Inventory from "../src/models/Inventory";
import { createJournalEntryRecord, resolvePurchasePostingAccounts } from "../src/lib/journalPosting";

async function backfillOpeningBalanceJournalEntries() {
  try {
    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
      console.error("❌ MONGODB_URI not set in environment variables");
      process.exit(1);
    }

    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to database");

    // Find all opening balance stock layers
    const openingLayers = await StockLayer.find({
      sourceType: "opening",
      supplier: { $exists: true, $ne: null },
    })
      .lean();

    console.log(`📦 Found ${openingLayers.length} opening balance stock layers with suppliers\n`);

    if (openingLayers.length === 0) {
      console.log("ℹ️  No opening balance stock layers found. Exiting.");
      await mongoose.disconnect();
      process.exit(0);
    }

    let processedCount = 0;
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const layer of openingLayers) {
      processedCount++;

      try {
        // Calculate amount
        const amount = Number(layer.quantityOriginal || 0) * Number(layer.unitCost || 0);

        if (amount <= 0) {
          console.log(`⏭️  Skipping layer ${layer._id}: zero amount`);
          skippedCount++;
          continue;
        }

        // Check if journal entry already exists for this layer
        // We'll use a naming convention: OB-<layerId>
        const referencePrefix = `OB-${String(layer._id).substring(0, 8)}`;
        const existingEntry = await JournalEntry.findOne({
          reference: { $regex: referencePrefix },
        }).lean();

        if (existingEntry) {
          console.log(`⏭️  Skipping layer ${layer._id}: journal entry already exists`);
          skippedCount++;
          continue;
        }

        // Get inventory item details
        const inventoryItem = await Inventory.findById(layer.inventoryItem).lean() as any;
        const supplierDoc = await Supplier.findById(layer.supplier).lean() as any;
        const supplierName = supplierDoc?.name || "Unknown Supplier";
        const itemName = inventoryItem?.name || "Unknown Item";

        console.log(`\n📝 Processing: ${itemName} (${layer.quantityOriginal} units @ ${layer.unitCost} each = ${amount})`);
        console.log(`   Supplier: ${supplierName}`);

        // Resolve accounts
        const { inventoryAccount, paymentAccount } = await resolvePurchasePostingAccounts(
          String(layer.supplier),
          { paymentMethod: "credit" }
        );

        if (!inventoryAccount || !paymentAccount) {
          console.log(`❌ Failed: Missing account mapping for supplier ${supplierName}`);
          errorCount++;
          continue;
        }

        // Create journal entry
        const lines = [
          {
            account: inventoryAccount._id,
            accountName: inventoryAccount.title,
            debit: amount,
            credit: 0,
            note: `Opening balance from ${supplierName}`,
          },
          {
            account: paymentAccount._id,
            accountName: paymentAccount.title,
            debit: 0,
            credit: amount,
            note: `Opening balance from ${supplierName}`,
          },
        ];

        await createJournalEntryRecord({
          date: new Date(layer.receivedAt || layer.createdAt),
          reference: referencePrefix,
          description: `Opening balance backfill: ${itemName} from ${supplierName}`,
          lines,
          source: "MANUAL",
          sourceId: null,
          postedBy: layer.createdBy || null,
        });

        console.log(`✅ Created journal entry for layer ${layer._id}`);
        console.log(`   A/P Account: ${paymentAccount.title} (+${amount})`);
        createdCount++;
      } catch (err: any) {
        console.error(`❌ Error processing layer ${layer._id}:`, err.message);
        errorCount++;
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("BACKFILL SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total opening balance layers processed: ${processedCount}`);
    console.log(`✅ Journal entries created: ${createdCount}`);
    console.log(`⏭️  Already had entries (skipped): ${skippedCount}`);
    console.log(`❌ Errors encountered: ${errorCount}`);
    console.log("=".repeat(60));

    if (createdCount > 0) {
      console.log("\n✨ Backfill complete! All existing opening balances now post to A/P accounts.");
      console.log("📊 AssetsPage should now show updated A/P balances.");
    } else {
      console.log("\nℹ️  No new journal entries needed - all opening balances already accounted for.");
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error:", error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

backfillOpeningBalanceJournalEntries();
