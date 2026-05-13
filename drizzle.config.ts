/**
 * Drizzle Kit config — reads `DATABASE_URL` from process.env / .env file.
 * Runs in a CommonJS context, so we manually load .env via `dotenv/config`.
 */

import "dotenv/config";
import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  throw new Error("drizzle.config: DATABASE_URL is required (set it in .env)");
}

export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
} satisfies Config;
