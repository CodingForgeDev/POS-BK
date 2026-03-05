import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local first, fall back to .env
config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });
