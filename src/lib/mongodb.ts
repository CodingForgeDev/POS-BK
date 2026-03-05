import mongoose from "mongoose";

let isConnected = false;

export async function connectDB(): Promise<void> {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  await mongoose.connect(uri, { bufferCommands: false });
  isConnected = true;
  console.log("MongoDB connected");
}

export default connectDB;
