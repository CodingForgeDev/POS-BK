import mongoose from "mongoose";

const AttendanceSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    date: { type: Date, required: true },
    clockIn: { type: Date, default: null },
    clockOut: { type: Date, default: null },
    hoursWorked: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["present", "absent", "late", "half-day", "leave"],
      default: "present",
    },
    notes: { type: String, default: "" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AttendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

export default (mongoose.models.Attendance || mongoose.model("Attendance", AttendanceSchema)) as mongoose.Model<any>;


