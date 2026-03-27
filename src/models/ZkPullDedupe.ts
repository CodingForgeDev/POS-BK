import mongoose from "mongoose";

/** One document per processed punch fingerprint — prevents re-applying the same device rows on every sync. */
const ZkPullDedupeSchema = new mongoose.Schema(
  {
    // unique:true creates an implicit B-tree index on fingerprint.
    // zkPullService uses a single $in query against this index to batch-check an entire sync's
    // worth of fingerprints before entering the per-record loop — avoids N individual findOne calls.
    fingerprint: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

// Cap collection growth: fingerprints older than ~180 days expire via MongoDB TTL background job.
ZkPullDedupeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 15552000 });

export default (mongoose.models.ZkPullDedupe ||
  mongoose.model("ZkPullDedupe", ZkPullDedupeSchema)) as mongoose.Model<{
  fingerprint: string;
}>;
