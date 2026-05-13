/**
 * Consumes the `send` queue.
 *
 *   Notion page id
 *     ↓ getPage + buildSendJobFromNotion
 *     ↓ writer.markSending
 *     ↓ Graph sendMail (or createReply+send when Action=reply and Payload has replyToGraphMessageId)
 *     ↓ findRecentSentMessage (sendMail path only) to capture {messageId, conversationId, internetMessageId}
 *     ↓ persist outbound_messages
 *     ↓ writer.writeSendSuccess (writes Status, Completion Time, Payload._graph)
 *
 * Failures flow to writer.writeSendFailure with the error message.
 */

import { Worker, type Job } from "bullmq";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../queues/connection.js";
import { QUEUE_NAMES, type SendJobData } from "../queues/queues.js";
import { buildSendJobFromNotion } from "../services/job-builder.service.js";
import { findRecentSentMessage, sendMail, sendMailReplyInThread, type SentItemsLookupHit } from "../graph/mail.service.js";
import { findMailboxByEmail } from "../db/repositories/mailbox.repo.js";
import { recordOutbound } from "../services/message-store.service.js";
import { markSending, writeSendFailure, writeSendSuccess } from "../notion/writer.js";
import { sleep } from "../utils/sleep.js";

let worker: Worker<SendJobData> | null = null;

async function process(job: Job<SendJobData>): Promise<void> {
  const { notionPageId } = job.data;
  logger.info({ jobId: job.id, notionPageId }, "send: start");

  const built = await buildSendJobFromNotion(notionPageId);
  const { draft } = built;
  const replyAnchor = (draft.replyToGraphMessageId ?? "").trim();
  const isReplyInThread = built.actionType === "reply" && replyAnchor.length > 0;

  /** Notion row data problems — mark Failure and finish job (no BullMQ retry storm). */
  const softFail = async (msg: string): Promise<void> => {
    logger.warn({ jobId: job.id, notionPageId, err: msg }, "send: skipped (invalid notion row)");
    await writeSendFailure(notionPageId, { errorText: msg }).catch((e) =>
      logger.error({ err: e }, "writeSendFailure failed"),
    );
  };

  if (!draft.fromMailbox) {
    await softFail("missing sender (FCAccount empty)");
    return;
  }
  if (built.actionType === "reply" && !isReplyInThread) {
    await softFail(
      'Action Reply requires Payload.replyToGraphMessageId (set automatically when an inbound reply is matched; re-open the row after "Last Reply Time" updates, or paste the id from Payload JSON)',
    );
    return;
  }
  if (!isReplyInThread && draft.to.length === 0) {
    await softFail("missing recipient (no Payload.to_email / Reply Email)");
    return;
  }
  if (!isReplyInThread && !draft.subject) {
    await softFail("missing subject");
    return;
  }
  if (!draft.bodyHtml) {
    await softFail("missing body");
    return;
  }

  const mailbox = await findMailboxByEmail(draft.fromMailbox);
  if (!mailbox || !mailbox.enabled || !mailbox.canSend) {
    await softFail(`mailbox not enabled for send: ${draft.fromMailbox}`);
    return;
  }

  try {
    await markSending(notionPageId);

    let hit: SentItemsLookupHit;
    if (isReplyInThread) {
      hit = await sendMailReplyInThread({
        fromMailbox: draft.fromMailbox,
        replyToMessageId: replyAnchor,
        bodyHtml: draft.bodyHtml,
        isHtml: draft.isHtml,
        subject: draft.subject?.trim() || undefined,
      });
      logger.info(
        { notionPageId, replyToMessageId: replyAnchor.slice(0, 24), conversationId: hit.conversationId },
        "send: reply-in-thread (Graph createReply) sent",
      );
    } else {
      await sendMail(draft);

      // Graph sendMail returns 202 without the new message id. Wait briefly
      // for Sent Items propagation, then look it up.
      let found: SentItemsLookupHit | null = null;
      for (let attempt = 0; attempt < 4 && !found; attempt += 1) {
        await sleep(1000 + attempt * 1500);
        found = await findRecentSentMessage(draft.fromMailbox, draft.subject, draft.to[0]!).catch((e) => {
          logger.warn({ err: e }, "findRecentSentMessage failed; will retry");
          return null;
        });
      }
      if (!found) {
        throw new Error(
          "send succeeded but failed to locate sent-items metadata; cannot record conversationId",
        );
      }
      hit = found;
    }

    const sentAt = new Date(hit.sentAt);
    await recordOutbound({
      mailboxId: mailbox.id,
      notionPageId,
      graphMessageId: hit.graphMessageId,
      internetMessageId: hit.internetMessageId,
      conversationId: hit.conversationId,
      subject: hit.subject,
      sentAt,
      recipientsJson: { to: draft.to, cc: draft.cc ?? [], bcc: draft.bcc ?? [] } as any,
      metaJson: { actionType: built.actionType } as any,
      threadStatus: "sent",
    });

    await writeSendSuccess(notionPageId, {
      graphMessageId: hit.graphMessageId,
      conversationId: hit.conversationId,
      internetMessageId: hit.internetMessageId,
      sentAt,
    });

    logger.info(
      {
        notionPageId,
        from: draft.fromMailbox,
        to: draft.to,
        conversationId: hit.conversationId,
        status: loadConfig().notion.status_values.success,
      },
      "send: success (notion status verified)",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, notionPageId }, "send: failed");
    // Best-effort failure write — never let writer failure mask the original.
    await writeSendFailure(notionPageId, { errorText: msg }).catch((e) =>
      logger.error({ err: e }, "writeSendFailure failed"),
    );
    throw err;
  }
}

export function startSendWorker(): void {
  if (worker) return;
  const cfg = loadConfig();
  worker = new Worker<SendJobData>(QUEUE_NAMES.send, process, {
    connection: getRedis(),
    concurrency: cfg.polling.send_concurrency,
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, "send worker job failed");
  });
  logger.info({ concurrency: cfg.polling.send_concurrency }, "send worker started");
}

export async function stopSendWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("send worker stopped");
  }
}
