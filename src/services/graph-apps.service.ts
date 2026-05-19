/**
 * Load / refresh Graph Azure apps from Postgres (`graph_apps` table).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { graphApps } from "../db/schema/graph_apps.js";
import { loadConfig } from "../config/index.js";
import {
  getEffectiveGraphAppsSync,
  markGraphAppsDbRefreshed,
  setGraphAppsDbCache,
  type GraphAppCredentials,
} from "../config/graph-apps.runtime.js";
import { evictGraphAppClients } from "../auth/msal.js";
import { logger } from "../utils/logger.js";

function diffEvictKeys(
  prev: Record<string, GraphAppCredentials>,
  next: Record<string, GraphAppCredentials>,
): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(prev)) {
    if (!next[k]) out.add(k);
    else {
      const a = prev[k]!;
      const b = next[k]!;
      if (a.tenant_id !== b.tenant_id || a.client_id !== b.client_id || a.client_secret !== b.client_secret) {
        out.add(k);
      }
    }
  }
  for (const k of Object.keys(next)) {
    if (!prev[k]) out.add(k);
  }
  return [...out];
}

/** Reload enabled rows into the in-process cache and evict stale MSAL clients. */
export async function refreshGraphAppsFromDb(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.graph_apps_source !== "db") {
    setGraphAppsDbCache({});
    return;
  }

  const prev = { ...getEffectiveGraphAppsSync(cfg) };
  const rows = await db
    .select()
    .from(graphApps)
    .where(eq(graphApps.enabled, true));

  const next: Record<string, GraphAppCredentials> = {};
  for (const r of rows) {
    const key = r.domain.trim().toLowerCase();
    if (!key) continue;
    next[key] = {
      tenant_id: r.tenantId,
      client_id: r.clientId,
      client_secret: r.clientSecret,
    };
  }

  const toEvict = diffEvictKeys(prev, next);
  evictGraphAppClients(toEvict);
  setGraphAppsDbCache(next);
  markGraphAppsDbRefreshed();
  logger.info({ domains: Object.keys(next).length, evictedMsal: toEvict.length }, "graph_apps DB cache refreshed");
}
