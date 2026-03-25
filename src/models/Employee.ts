import mongoose from "mongoose";

// Login role / permissions live on `User`. PATCH /employees/:id updates `User.role` only for admins.
const EmployeeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    employeeId: { type: String, unique: true, required: true },
    // ZKTeco device User/PIN identifier (e.g. MB460/ID “User ID” / “PIN”).
    // If not provided, we fall back to employeeId for backward compatibility.
    deviceUserId: { type: String, default: null },
    position: { type: String, required: true },
    department: { type: String, required: true },
    salary: { type: Number, default: 0 },
    salaryType: { type: String, enum: ["hourly", "weekly", "monthly"], default: "hourly" },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    emergencyContact: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      relationship: { type: String, default: "" },
    },
    address: { type: String, default: "" },
    taxFileNumber: { type: String, default: "" },
    bankAccount: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

export default (mongoose.models.Employee || mongoose.model("Employee", EmployeeSchema)) as mongoose.Model<any>;


