/**
 * Inbox poller (V1 = Polling-first; V2 can disable scheduler via config).
 *
 * Two components:
 *
 *   1. `startInboxScheduler` — every `polling.inbox_interval_ms`, enumerate
 *      enabled mailboxes × configured folders and enqueue one `inbox-poll`
 *      job per pair. Jobs are deduped per cycle by jobId.
 *
 *   2. `startInboxWorker` — consumes those jobs, pulls new messages from
 *      Graph since the per-folder cursor, persists slim rows into
 *      `inbox_messages`, and fans each fresh row out to the `match` queue.
 *
 * Cursor semantics:
 *   - We advance `{folder}_last_sync_at` to the MAX(`receivedDateTime`)
 *     we observed in this batch — only when we wrote at least one new row.
 *   - On the very first poll for a mailbox (cursor NULL), we read the last
 *     5 minutes so we don't drown the queue with backfill.
 */

import { Worker, type Job } from "bullmq";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../queues/connection.js";
import { QUEUE_NAMES, inboxPollQueue, type InboxPollJobData } from "../queues/queues.js";
import {
  listEnabledMailboxes,
  readFolderCursor,
  setFolderCursor,
} from "../db/repositories/mailbox.repo.js";
import { pullFolderMessages, type InboxMessageSlim } from "../graph/mail.service.js";
import { ingestInboxMessageBatch } from "../services/inbox-ingest.service.js";

let scheduler: NodeJS.Timeout | null = null;
let worker: Worker<InboxPollJobData> | null = null;
let schedTickInFlight = false;

const INITIAL_BACKFILL_MS = 5 * 60 * 1000;

async function scheduleTick(): Promise<void> {
  if (schedTickInFlight) return;
  schedTickInFlight = true;
  try {
    const cfg = loadConfig();
    const boxes = await listEnabledMailboxes();
    let enq = 0;
    for (const box of boxes) {
      if (!box.canReceive) continue;
      for (const folder of cfg.folders) {
        await inboxPollQueue.add(
          "inbox-poll",
          { mailboxId: box.id, email: box.email, folder },
          { jobId: `poll__${box.id}__${folder}` },
        );
        enq += 1;
      }
    }
    if (enq > 0) logger.debug({ enq }, "inbox scheduler enqueued");
  } catch (err) {
    logger.error({ err }, "inbox scheduler tick failed");
  } finally {
    schedTickInFlight = false;
  }
}

function pickReceivedSince(cursor: Date | null): string {
  const fallback = new Date(Date.now() - INITIAL_BACKFILL_MS);
  const since = cursor ?? fallback;
  return since.toISOString();
}

async function processPoll(job: Job<InboxPollJobData>): Promise<void> {
  const { mailboxId, email, folder } = job.data;
  const boxes = await listEnabledMailboxes();
  const box = boxes.find((b) => b.id === mailboxId);
  if (!box) {
    logger.warn({ mailboxId }, "inbox poll: mailbox missing/disabled, skipping");
    return;
  }
  const cursor = readFolderCursor(box, folder);
  const sinceIso = pickReceivedSince(cursor);

  let messages: InboxMessageSlim[] = [];
  try {
    messages = await pullFolderMessages({ mailbox: email, folder, sinceIso, pageSize: 50 });
  } catch (err) {
    logger.error({ err, email, folder, sinceIso }, "inbox poll: graph fetch failed");
    return;
  }

  if (messages.length === 0) return;

  const { written, maxReceivedAt } = await ingestInboxMessageBatch(messages, mailboxId, folder);
  if (written > 0 && maxReceivedAt) {
    await setFolderCursor(mailboxId, folder, maxReceivedAt);
    logger.info(
      { email, folder, written, cursor: maxReceivedAt.toISOString() },
      "inbox poll: wrote new messages",
    );
  }
}

export function startInboxScheduler(): void {
  if (scheduler) return;
  const cfg = loadConfig();
  if (cfg.v2.enabled && cfg.v2.disable_polling_when_v2) {
    logger.info("inbox scheduler skipped (v2.disable_polling_when_v2=true)");
    return;
  }
  void scheduleTick();
  scheduler = setInterval(() => void scheduleTick(), cfg.polling.inbox_interval_ms);
  logger.info({ intervalMs: cfg.polling.inbox_interval_ms }, "inbox scheduler started");
}

export function startInboxWorker(): void {
  if (worker) return;
  const cfg = loadConfig();
  worker = new Worker<InboxPollJobData>(QUEUE_NAMES.inboxPoll, processPoll, {
    connection: getRedis(),
    concurrency: cfg.polling.inbox_concurrency,
  });
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, "inbox worker job failed"),
  );
  logger.info({ concurrency: cfg.polling.inbox_concurrency }, "inbox worker started");
}

export async function stopInbox(): Promise<void> {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
  if (worker) {
    await worker.close();
    worker = null;
  }
  logger.info("inbox scheduler + worker stopped");
}
