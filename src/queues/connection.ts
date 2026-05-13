/**
 * BullMQ + ioredis shared connection.
 * BullMQ requires `maxRetriesPerRequest: null` and disabled offline queue.
 */

// ioredis ESM default-export quirk: `import IORedis from "ioredis"` resolves
// to the module namespace under nodenext + bundled types. Use the named class
// via `Redis` (re-exported by the package) and a typed default factory.
import { Redis } from "ioredis";
import { loadConfig } from "../config/index.js";

let connection: Redis | null = null;

export function getRedis(): Redis {
  if (connection) return connection;
  const cfg = loadConfig();
  connection = new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password || undefined,
    db: cfg.redis.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return connection;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const r = getRedis();
    const pong = await r.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}
