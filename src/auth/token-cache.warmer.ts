/**
 * Periodic warmer for App-only access tokens — one cache entry per
 * configured Azure App (per domain).
 *
 * Runs as a plain setInterval (not BullMQ): single-process concern, nothing
 * to fan out across machines.
 */

import { loadConfig } from "../config/index.js";
import { getEffectiveGraphAppsSync } from "../config/graph-apps.runtime.js";
import { logger } from "../utils/logger.js";
import { acquireGraphTokenForApp } from "./msal.js";

let timer: NodeJS.Timeout | null = null;

export function startTokenWarmer(): void {
  if (timer) return;
  const cfg = loadConfig();
  const tick = async (): Promise<void> => {
    const cfg = loadConfig();
    const apps = Object.keys(getEffectiveGraphAppsSync(cfg));
    for (const appKey of apps) {
      try {
        await acquireGraphTokenForApp(appKey);
      } catch (err) {
        logger.error({ err, app: appKey }, "token warmer failed for app");
      }
    }
  };
  void tick();
  const period = Math.max(60_000, Math.floor(cfg.polling.token_warm_skew_ms / 2));
  timer = setInterval(() => void tick(), period);
  logger.info(
    { periodMs: period, apps: Object.keys(getEffectiveGraphAppsSync(cfg)).length },
    "token warmer started",
  );
}

export async function stopTokenWarmer(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("token warmer stopped");
  }
}
