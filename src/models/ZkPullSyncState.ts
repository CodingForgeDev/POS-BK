import mongoose from "mongoose";

/** Singleton-style doc (`_id: "zk-pull"`) for last ZK TCP pull sync run metadata. */
const ZkPullSyncStateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    lastSyncAt: { type: Date, default: null },
    lastSuccess: { type: Boolean, default: false },
    logsFetched: { type: Number, default: 0 },
    logsProcessed: { type: Number, default: 0 },
    logsSkipped: { type: Number, default: 0 },
    employeeNotFound: { type: Number, default: 0 },
    unknownPunchType: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

export default (mongoose.models.ZkPullSyncState ||
  mongoose.model("ZkPullSyncState", ZkPullSyncStateSchema)) as mongoose.Model<{
  _id: string;
  lastSyncAt: Date | null;
  lastSuccess: boolean;
  logsFetched: number;
  logsProcessed: number;
  logsSkipped: number;
  employeeNotFound: number;
  unknownPunchType: number;
  lastError: string | null;
}>;
