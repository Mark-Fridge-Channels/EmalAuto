/**
 * Worker entrypoint.
 *
 * Boots BullMQ consumers for: send / inbox-poll / match / webhook-ingest (V2),
 * plus V2 subscription + delta maintenance timers.
 * Run alongside the server: `npm run dev:worker`.
 */

import { loadConfig, printConfigSummary } from "./config/index.js";
import { getEffectiveGraphAppsSync } from "./config/graph-apps.runtime.js";
import { logger } from "./utils/logger.js";
import { auditMailboxesAgainstApps } from "./db/repositories/mailbox.repo.js";
import { refreshGraphAppsFromDb } from "./services/graph-apps.service.js";
import { startSendWorker, stopSendWorker } from "./workers/send.worker.js";
import { startInboxScheduler, startInboxWorker, stopInbox } from "./workers/inbox.worker.js";
import { startMatchWorker, stopMatchWorker } from "./workers/match.worker.js";
import { startTokenWarmer, stopTokenWarmer } from "./auth/token-cache.warmer.js";
import { startWebhookIngestWorker, stopWebhookIngestWorker } from "./workers/webhook-ingest.worker.js";
import { startV2Maintenance, stopV2Maintenance } from "./workers/v2-maintenance.worker.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  printConfigSummary();
  if (cfg.graph_apps_source === "db") {
    await refreshGraphAppsFromDb();
    if (Object.keys(getEffectiveGraphAppsSync(cfg)).length === 0) {
      console.error("GRAPH_APPS_SOURCE=db but graph_apps has no enabled rows");
      process.exit(2);
    }
  }
  await auditMailboxesAgainstApps();

  startTokenWarmer();
  startSendWorker();
  startMatchWorker();

  if (cfg.v2.enabled) {
    startV2Maintenance();
    startWebhookIngestWorker();
    if (!cfg.v2.disable_polling_when_v2) {
      startInboxScheduler();
    } else {
      logger.info("inbox polling scheduler disabled (v2.disable_polling_when_v2=true)");
    }
  } else {
    startInboxScheduler();
  }
  startInboxWorker();

  const shutdown = async (signal: string) => {
    logger.warn({ signal }, "worker shutting down");
    stopV2Maintenance();
    await Promise.allSettled([
      stopSendWorker(),
      stopInbox(),
      stopMatchWorker(),
      stopWebhookIngestWorker(),
      stopTokenWarmer(),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("worker booted");
}

main().catch((err) => {
  console.error("worker fatal:", err);
  process.exit(1);
});
