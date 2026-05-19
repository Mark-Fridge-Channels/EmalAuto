/**
 * In-memory Graph app registry for `GRAPH_APPS_SOURCE=db`.
 * Populated by `services/graph-apps.service.ts` — no DB imports here
 * (avoids config ↔ db circular init).
 */

import type { AppConfig } from "./index.js";

export type GraphAppCredentials = {
  tenant_id: string;
  client_id: string;
  client_secret: string;
};

let dbAppsCache: Record<string, GraphAppCredentials> = {};
let lastDbRefreshMs = 0;

export function setGraphAppsDbCache(apps: Record<string, GraphAppCredentials>): void {
  dbAppsCache = apps;
}

export function getEffectiveGraphAppsSync(cfg: AppConfig): Record<string, GraphAppCredentials> {
  if (cfg.graph_apps_source === "db") return dbAppsCache;
  return cfg.graph_apps;
}

export function getLastGraphAppsDbRefreshMs(): number {
  return lastDbRefreshMs;
}

export function markGraphAppsDbRefreshed(): void {
  lastDbRefreshMs = Date.now();
}
