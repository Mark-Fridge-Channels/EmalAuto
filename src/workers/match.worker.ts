/**
 * Consumes the `match` queue, one inbox row at a time.
 *
 *   inbox row
 *     ↓ bounce detector (heuristic)
 *     ↓ matchInboundByConversation
 *     ├── matched + bounce → mark outbound bounce + write Notion bounce
 *     ├── matched + reply  → create NEW Notion row (Action = Inbound Reply,
 *     │                       Payload.replyToGraphMessageId = anchor) and stamp
 *     │                       parent outbound row's Reply Status = Done
 *     └── unmatched        → mark inbox ignored, no Notion writeback
 *
 * Idempotency: inbox rows already in `matched` / `bounce` state are skipped.
 */

import { Worker, type Job } from "bullmq";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../queues/connection.js";
import { QUEUE_NAMES, type MatchJobData } from "../queues/queues.js";
import { findInboxById, markInboxIgnored, markInboxMatched } from "../db/repositories/inbox.repo.js";
import { findMailboxById } from "../db/repositories/mailbox.repo.js";
import { matchInboundByConversation } from "../services/reply-matcher.service.js";
import { detectBounce } from "../services/bounce-detector.service.js";
import { markOutboundBounce } from "../services/message-store.service.js";
import { upsertConversation } from "../db/repositories/conversation.repo.js";
import { createInboundReplyRow, markOriginalReplyDone, writeBounce } from "../notion/writer.js";

let worker: Worker<MatchJobData> | null = null;

async function processMatch(job: Job<MatchJobData>): Promise<void> {
  const row = await findInboxById(job.data.inboxRowId);
  if (!row) {
    logger.warn({ inboxRowId: job.data.inboxRowId }, "match: inbox row not found, skipping");
    return;
  }

  // Idempotency guard. Since we now CREATE a child Notion row (instead of
  // patching the parent), re-running on a row whose match_status is already
  // matched/bounce would produce a duplicate. Skip those.
  if (row.matchStatus === "matched" || row.matchStatus === "bounce") {
    logger.debug(
      { inboxRowId: row.id, matchStatus: row.matchStatus },
      "match: inbox row already finalized, skipping",
    );
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

    // Receiving mailbox = the local mailbox that ingested this inbound. Resolve
    // it lazily here (the schema already knows mailboxId -> email).
    const receivingMailbox = await emailForMailboxId(row.mailboxId);

    const newPageId = await createInboundReplyRow({
      parentOutboundNotionPageId: matched.notionPageId,
      receivingMailbox,
      fromEmail: row.fromEmail,
      subject: row.subject,
      bodyPreview: row.bodyPreview,
      replyAnchorGraphMessageId: row.graphMessageId,
      conversationId: row.conversationId,
      internetMessageId: row.internetMessageId ?? null,
      receivedAt: row.receivedAt,
    });

    // Best-effort: stamp Reply Status = Done on the original outbound row.
    // Failure here is logged but must not block the child row from existing.
    await markOriginalReplyDone(matched.notionPageId).catch((err) =>
      logger.warn(
        { err, parentOutboundNotionPageId: matched.notionPageId },
        "match: failed to stamp parent Reply Status = Done (child row already created)",
      ),
    );

    logger.info(
      {
        inboxRowId: row.id,
        outboundId: matched.outboundId,
        newNotionPageId: newPageId,
        parentOutboundNotionPageId: matched.notionPageId,
      },
      "match: inbound-reply child row created",
    );
  }
}

async function emailForMailboxId(mailboxId: number): Promise<string> {
  const box = await findMailboxById(mailboxId);
  if (!box) throw new Error(`mailbox ${mailboxId} not found while creating inbound-reply row`);
  return box.email;
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
