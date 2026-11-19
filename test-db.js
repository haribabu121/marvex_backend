
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

async function testConnection() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.log("ERROR: MONGODB_URI not loaded");
    process.exit(1);
  }

  try {
    const parsed = new URL(uri);

    console.log("Environment loaded successfully");
    console.log("MongoDB host:", parsed.hostname);
    console.log("Database:", parsed.pathname);
    console.log("Username:", decodeURIComponent(parsed.username));
    console.log("Password length:", decodeURIComponent(parsed.password).length);

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log("SUCCESS: MongoDB Atlas connected!");

    await mongoose.disconnect();
    process.exit(0);

  } catch (error) {
    console.error("CONNECTION FAILED:", error.message);
    process.exit(1);
  }
}

testConnection();
