import mongoose from "mongoose";

const CustomerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    dateOfBirth: { type: Date, default: null },
    address: { type: String, default: "" },
    loyaltyPoints: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    tags: [{ type: String }],
    isActive: { type: Boolean, default: true },
    lastVisit: { type: Date, default: null },
    birthdayOfferSent: { type: Boolean, default: false },
    birthdayOfferSentYear: { type: Number, default: null },
  },
  { timestamps: true }
);

export default (mongoose.models.Customer || mongoose.model("Customer", CustomerSchema)) as mongoose.Model<any>;


