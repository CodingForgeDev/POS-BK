/**
 * Run this script once to create the first admin user.
 * Usage: node scripts/seed-admin.js
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

// Manually load .env.local since Node.js doesn't do it automatically
const envPath = path.join(__dirname, "../.env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] = rest.join("=").trim();
  }
}

const MONGODB_URI = process.env.MONGODB_URI;

const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  role: String,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model("User", UserSchema);

async function seedAdmin() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB");

    const existing = await User.findOne({ email: "admin@poscafe.com" });
    if (existing) {
      console.log("⚠ Admin user already exists. Skipping.");
      process.exit(0);
    }

    const hashedPassword = await bcrypt.hash("admin123", 12);

    await User.create({
      name: "Admin",
      email: "admin@poscafe.com",
      password: hashedPassword,
      role: "admin",
      isActive: true,
    });

    console.log("\n✅ Admin user created successfully!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Email   : admin@poscafe.com");
    console.log("  Password: admin123");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\nChange the password after first login!\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedAdmin();
