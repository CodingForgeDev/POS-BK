import mongoose, { Schema } from "mongoose";

export interface IZkDeviceUser {
  userId: string; // ZKTeco PIN — matches Employee.deviceUserId
  name: string;
  uid: number;
  role: number;
  syncedAt: Date;
}

const ZkDeviceUserSchema = new Schema<IZkDeviceUser>(
  {
    userId:   { type: String, required: true, unique: true, trim: true },
    name:     { type: String, default: "", trim: true },
    uid:      { type: Number, default: 0 },
    role:     { type: Number, default: 0 },
    syncedAt: { type: Date, default: Date.now },
  },
  { collection: "zkdeviceusers", timestamps: false }
);

export default (mongoose.models.ZkDeviceUser ||
  mongoose.model<IZkDeviceUser>("ZkDeviceUser", ZkDeviceUserSchema)) as mongoose.Model<IZkDeviceUser>;
