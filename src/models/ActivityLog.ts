import mongoose from "mongoose";

const ActivityLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true },
    module: {
      type: String,
      enum: ["orders", "billing", "menu", "inventory", "employees", "customers", "discounts", "expenses", "reports", "settings", "auth"],
      required: true,
    },
    description: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "" },
  },
  { timestamps: true }
);

ActivityLogSchema.index({ user: 1, createdAt: -1 });
ActivityLogSchema.index({ module: 1, createdAt: -1 });

export default (mongoose.models.ActivityLog || mongoose.model("ActivityLog", ActivityLogSchema)) as mongoose.Model<any>;


