/**
 * GET /health — liveness + dependency probes (Postgres, Redis, Notion DB,
 * and ALL configured Graph apps).
 */

import type { FastifyInstance } from "fastify";
import { peekCachedTokens, acquireGraphTokenForApp } from "../auth/msal.js";
import { pingDb } from "../db/client.js";
import { pingRedis } from "../queues/connection.js";
import { retrieveDatabase } from "../notion/client.js";
import { loadConfig } from "../config/index.js";
import { getEffectiveGraphAppsSync } from "../config/graph-apps.runtime.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const cfg = loadConfig();
    const appKeys = Object.keys(getEffectiveGraphAppsSync(cfg));

    const [dbOk, redisOk, notionOk, graphAppResults] = await Promise.all([
      pingDb(),
      pingRedis(),
      retrieveDatabase(cfg.notion.database_id)
        .then(() => true)
        .catch(() => false),
      Promise.all(
        appKeys.map(async (k) => {
          try {
            await acquireGraphTokenForApp(k);
            return [k, true] as const;
          } catch {
            return [k, false] as const;
          }
        }),
      ),
    ]);
    const graphPerApp = Object.fromEntries(graphAppResults);
    const graphOk = appKeys.length > 0 && Object.values(graphPerApp).every(Boolean);
    const ok = dbOk && redisOk && notionOk && graphOk;
    return {
      ok,
      dependencies: { postgres: dbOk, redis: redisOk, notion: notionOk, graph: graphOk },
      graph_apps: graphPerApp,
      tokens: peekCachedTokens(),
    };
  });
}
