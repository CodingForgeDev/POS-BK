import mongoose from "mongoose";

/** One document per processed punch fingerprint — prevents re-applying the same device rows on every sync. */
const ZkPullDedupeSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

// Cap growth: old fingerprints expire automatically (TTL on createdAt from Mongoose timestamps).
ZkPullDedupeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 15552000 }); // ~180 days

export default (mongoose.models.ZkPullDedupe ||
  mongoose.model("ZkPullDedupe", ZkPullDedupeSchema)) as mongoose.Model<{
  fingerprint: string;
}>;
