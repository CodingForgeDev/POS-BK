import mongoose from "mongoose";

const SettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

const Setting = mongoose.models.Setting || mongoose.model("Setting", SettingSchema);
export default Setting;
