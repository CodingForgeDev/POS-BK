import mongoose from "mongoose";

const PermissionSchema = new mongoose.Schema(
  {
    create: { type: Boolean, default: false },
    read: { type: Boolean, default: false },
    update: { type: Boolean, default: false },
    delete: { type: Boolean, default: false },
  },
  { _id: false }
);

const RoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: "" },
    allowedPaths: { type: [String], default: [] },
    permissions: {
      type: Map,
      of: PermissionSchema,
      default: {},
    },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default (mongoose.models.Role || mongoose.model("Role", RoleSchema)) as mongoose.Model<any>;
