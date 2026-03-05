import mongoose from "mongoose";

const SupplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true },
    address: { type: String, default: "" },
    supplyCategory: { type: String, default: "" },
    paymentTerms: { type: String, default: "" },
    bankDetails: { type: String, default: "" },
    taxNumber: { type: String, default: "" },
    notes: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    rating: { type: Number, min: 1, max: 5, default: null },
  },
  { timestamps: true }
);

export default (mongoose.models.Supplier || mongoose.model("Supplier", SupplierSchema)) as mongoose.Model<any>;


