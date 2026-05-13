/**
 * Fastify entrypoint.
 *
 * Owns:
 * - Health check
 * - Notion poller (kicks off send jobs)
 * - Webhook endpoints (added in V2)
 *
 * Workers (send/inbox/match) live in src/worker.ts so they can scale separately.
 */

import Fastify from "fastify";
import { loadConfig, printConfigSummary } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registerHealthRoutes } from "./routes/health.routes.js";
import { registerGraphWebhookRoutes } from "./routes/webhook.graph.routes.js";
import { startNotionPoller, stopNotionPoller } from "./notion/poller.js";
import { auditMailboxesAgainstApps } from "./db/repositories/mailbox.repo.js";
import { validateNotionSchema } from "./notion/schema-validator.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  printConfigSummary(cfg);

  // Fail loudly if the Notion DB doesn't match the configured field map.
  // (Network/auth errors here ALSO fail loudly — caller can see the cause.)
  const issues = await validateNotionSchema();
  if (issues.length > 0) {
    logger.error({ issues }, "notion schema check failed — aborting boot");
    process.exit(2);
  }

  await auditMailboxesAgainstApps();

  // Use Fastify's built-in pino with our level/pretty config rather than
  // injecting our pino instance — the type plumbing for `loggerInstance`
  // is finicky and gives us no extra value here.
  const app = Fastify({
    logger: {
      level: cfg.logging.level,
      ...(cfg.logging.pretty
        ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: true } } }
        : {}),
    },
  });
  await registerHealthRoutes(app);
  if (cfg.v2.enabled) {
    await registerGraphWebhookRoutes(app);
  }

  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  logger.info({ host: cfg.server.host, port: cfg.server.port }, "server listening");

  // Notion poller is part of the API process so single-instance dev works
  // out of the box. Move to worker.ts later if you scale horizontally.
  startNotionPoller();

  const shutdown = async (signal: string) => {
    logger.warn({ signal }, "shutting down");
    stopNotionPoller();
    await app.close().catch((e) => logger.error({ err: e }, "fastify close failed"));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // Use console because logger may not be initialized if config load failed.
  console.error("fatal:", err);
  process.exit(1);
});
