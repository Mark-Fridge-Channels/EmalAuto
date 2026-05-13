/**
 * Consumes `webhook-ingest` jobs produced by Graph change notifications.
 *
 * Fetches the full message via `GET /users/{id}/messages/{messageId}` then
 * reuses the same ingest path as polling / delta.
 */

import { Worker, type Job } from "bullmq";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../queues/connection.js";
import { QUEUE_NAMES, type WebhookIngestJobData } from "../queues/queues.js";
import { getMessageById } from "../graph/mail.service.js";
import { ingestInboxMessageBatch } from "../services/inbox-ingest.service.js";
import { findMailboxByEmail, setFolderCursor } from "../db/repositories/mailbox.repo.js";

let worker: Worker<WebhookIngestJobData> | null = null;

async function process(job: Job<WebhookIngestJobData>): Promise<void> {
  const { mailboxEmail, messageId, folder } = job.data;
  const box = await findMailboxByEmail(mailboxEmail);
  if (!box || !box.enabled || !box.canReceive) {
    logger.warn({ mailboxEmail }, "webhook-ingest: mailbox disabled or unknown");
    return;
  }
  const msg = await getMessageById(mailboxEmail, messageId);
  if (!msg) {
    logger.debug({ mailboxEmail, messageId }, "webhook-ingest: message gone (404)");
    return;
  }
  const { written, maxReceivedAt } = await ingestInboxMessageBatch([msg], box.id, folder);
  if (written > 0 && maxReceivedAt) {
    await setFolderCursor(box.id, folder, maxReceivedAt);
    logger.info({ mailboxEmail, messageId, folder, written }, "webhook-ingest: ingested");
  }
}

export function startWebhookIngestWorker(): void {
  if (worker) return;
  const cfg = loadConfig();
  worker = new Worker<WebhookIngestJobData>(QUEUE_NAMES.webhookIngest, process, {
    connection: getRedis(),
    concurrency: Math.max(2, cfg.polling.inbox_concurrency),
  });
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, "webhook-ingest job failed"),
  );
  logger.info("webhook-ingest worker started");
}

export async function stopWebhookIngestWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("webhook-ingest worker stopped");
  }
}
