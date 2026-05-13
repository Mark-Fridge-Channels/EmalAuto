/**
 * Apply Drizzle SQL migrations against the configured Postgres.
 *
 * Run with `npm run db:migrate` after `npm run db:generate`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const migrationsFolder = path.resolve(__dirname, "../../drizzle");
  logger.info({ migrationsFolder }, "applying migrations");
  await migrate(db, { migrationsFolder });
  logger.info("migrations applied");
  await pool.end();
}

main().catch(async (err) => {
  logger.error({ err }, "migrate failed");
  await pool.end().catch(() => undefined);
  process.exit(1);
});
