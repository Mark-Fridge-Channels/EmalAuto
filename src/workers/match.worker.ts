/**
 * Consumes the `match` queue, one inbox row at a time.
 *
 *   inbox row
 *     ↓ bounce detector (heuristic)
 *     ↓ matchInboundByConversation
 *     ├── matched + bounce → mark outbound bounce + write Notion bounce
 *     ├── matched + reply  → mark outbound reply_received + write Notion reply
 *     └── unmatched        → mark inbox ignored, no Notion writeback
 */

import { Worker, type Job } from "bullmq";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../queues/connection.js";
import { QUEUE_NAMES, type MatchJobData } from "../queues/queues.js";
import { findInboxById, markInboxIgnored, markInboxMatched } from "../db/repositories/inbox.repo.js";
import { matchInboundByConversation } from "../services/reply-matcher.service.js";
import { detectBounce } from "../services/bounce-detector.service.js";
import { markOutboundBounce } from "../services/message-store.service.js";
import { upsertConversation } from "../db/repositories/conversation.repo.js";
import { writeBounce, writeReply } from "../notion/writer.js";

let worker: Worker<MatchJobData> | null = null;

async function processMatch(job: Job<MatchJobData>): Promise<void> {
  const row = await findInboxById(job.data.inboxRowId);
  if (!row) {
    logger.warn({ inboxRowId: job.data.inboxRowId }, "match: inbox row not found, skipping");
    return;
  }

  const bounce = detectBounce({ fromEmail: row.fromEmail, subject: row.subject });
  const matched = await matchInboundByConversation(row.conversationId);

  if (!matched.matched) {
    if (bounce.isBounce) {
      logger.warn(
        {
          inboxRowId: row.id,
          conversationId: row.conversationId,
          subject: row.subject,
          from: row.fromEmail,
        },
        "match: bounce detected but no outbound conversation found",
      );
    }
    await markInboxIgnored(row.id);
    return;
  }

  if (bounce.isBounce && matched.outboundId && matched.notionPageId) {
    const reason = `${bounce.reason}; subject="${row.subject}"; from=${row.fromEmail}`;
    await markOutboundBounce(matched.outboundId, reason);
    await markInboxMatched(row.id, matched.outboundId, "bounce");
    await upsertConversation(row.conversationId, matched.notionPageId, row.id, row.receivedAt);
    await writeBounce(matched.notionPageId, {
      reason,
      inboundMessageId: row.graphMessageId,
      inboundConversationId: row.conversationId,
      receivedAt: row.receivedAt,
    });
    logger.info({ inboxRowId: row.id, outboundId: matched.outboundId }, "match: bounce written");
    return;
  }

  if (matched.outboundId && matched.notionPageId) {
    await markInboxMatched(row.id, matched.outboundId, "matched");
    await upsertConversation(row.conversationId, matched.notionPageId, row.id, row.receivedAt);
    await writeReply(matched.notionPageId, {
      replyBodyText: row.bodyPreview,
      replyFromEmail: row.fromEmail,
      receivedAt: row.receivedAt,
      replyAnchorGraphMessageId: row.graphMessageId,
    });
    logger.info({ inboxRowId: row.id, outboundId: matched.outboundId }, "match: reply written");
  }
}

export function startMatchWorker(): void {
  if (worker) return;
  const cfg = loadConfig();
  worker = new Worker<MatchJobData>(QUEUE_NAMES.match, processMatch, {
    connection: getRedis(),
    concurrency: cfg.polling.match_concurrency,
  });
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, "match worker job failed"),
  );
  logger.info({ concurrency: cfg.polling.match_concurrency }, "match worker started");
}

export async function stopMatchWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("match worker stopped");
  }
}
