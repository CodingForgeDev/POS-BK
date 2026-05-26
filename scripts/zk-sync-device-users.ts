/**
 * CLI: pull ZKTeco enrolled users into MongoDB (zkdeviceusers collection).
 * Same logic as GET /api/zk-pull/device-users — use when testing from the office PC.
 *
 * Usage (from POS-BK): npx tsx scripts/zk-sync-device-users.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/lib/mongodb";
import { syncZkDeviceUsersFromDevice } from "../src/integrations/zkteco/zkPullService";

async function main() {
  await connectDB();
  const result = await syncZkDeviceUsersFromDevice();
  // eslint-disable-next-line no-console
  console.log(`source=${result.source} users=${result.users.length} lastSyncedAt=${result.lastSyncedAt?.toISOString() ?? "—"}`);
  if (result.deviceError) {
    // eslint-disable-next-line no-console
    console.error("deviceError:", result.deviceError);
  }
  for (const u of result.users) {
    // eslint-disable-next-line no-console
    console.log(`  ${u.userId} — ${u.name || "(no name)"}`);
  }
  await mongoose.disconnect();
  process.exit(result.users.length > 0 || !result.deviceError ? 0 : 1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
