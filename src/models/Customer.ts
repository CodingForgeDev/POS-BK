import mongoose from "mongoose";

function normalizePhone(value: string): string {
  return String(value || "").replace(/[^+\d]/g, "");
}

const CustomerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true, default: "" },
    phone: { type: String, required: true, trim: true, unique: true },
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

CustomerSchema.pre("save", function (next) {
  if (this.phone && typeof this.phone === "string") {
    this.phone = normalizePhone(this.phone);
  }
  next();
});

export default (mongoose.models.Customer || mongoose.model("Customer", CustomerSchema)) as mongoose.Model<any>;


