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

    const admins = [
      { name: "Admin", email: "admin@poscafe.com", password: "admin123" },
      { name: "Codingforge Admin", email: "codingforge@codingforge.com", password: "codingforge123" },
    ];

    const hashedPassword1 = await bcrypt.hash(admins[0].password, 12);
    const hashedPassword2 = await bcrypt.hash(admins[1].password, 12);

    let createdCount = 0;

    // Create first admin
    const existing1 = await User.findOne({ email: admins[0].email });
    if (!existing1) {
      await User.create({
        name: admins[0].name,
        email: admins[0].email,
        password: hashedPassword1,
        role: "admin",
        isActive: true,
      });
      createdCount++;
      console.log("✅ Created: " + admins[0].email);
    } else {
      console.log("⚠ Already exists: " + admins[0].email);
    }

    // Create codingforge admin
    const existing2 = await User.findOne({ email: admins[1].email });
    if (!existing2) {
      await User.create({
        name: admins[1].name,
        email: admins[1].email,
        password: hashedPassword2,
        role: "admin",
        isActive: true,
      });
      createdCount++;
      console.log("✅ Created: " + admins[1].email);
    } else {
      console.log("⚠ Already exists: " + admins[1].email);
    }

    if (createdCount > 0) {
      console.log("\n✅ Admin users configured successfully!");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  Email   : admin@poscafe.com");
      console.log("  Password: admin123");
      console.log("  Role    : Admin (Full Access)");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  Email   : codingforge@codingforge.com");
      console.log("  Password: codingforge123");
      console.log("  Role    : Admin (Full Access)");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("\n⚠ Change passwords after first login!\n");
    } else {
      console.log("\n⚠ All admin users already exist. No changes made.\n");
    }

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

seedAdmin();
