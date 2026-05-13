/**
 * PostgreSQL connection (Drizzle + node-postgres).
 *
 * Single shared Pool driven by `DATABASE_URL`. We auto-enable TLS for any
 * non-local host (Supabase, RDS, Neon, etc.) with `rejectUnauthorized: false`
 * because Supabase/RDS roots aren't in node's default bundle; the connection
 * is still encrypted.
 */

import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "../config/index.js";
import * as schema from "./schema/index.js";

function shouldEnableSsl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.get("sslmode") === "disable") return false;
    const host = u.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return false;
    return true;
  } catch {
    return true;
  }
}

const cfg = loadConfig();
const sslEnabled = shouldEnableSsl(cfg.postgres.url);

const poolConfig: PoolConfig = {
  connectionString: cfg.postgres.url,
  max: cfg.postgres.max_pool,
};
if (sslEnabled) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

export const pool = new Pool(poolConfig);

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
