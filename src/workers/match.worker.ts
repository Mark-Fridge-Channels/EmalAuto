/**
 * Consumes the `match` queue, one inbox row at a time.
 *
 *   inbox row
 *     ↓ bounce detector (heuristic)
 *     ↓ resolveInboundOutboundMatch (conversationId → bounce recipient → legacy)
 *     ├── matched + bounce → mark outbound bounce + write Notion bounce
 *     ├── matched + auto-reply → link inbox only (no reply_received / no IL child)
 *     ├── matched + human reply → Notion Inbound Reply child + parent Done
 *     └── unmatched        → mark inbox ignored, no Notion writeback
 *
 * Idempotency: inbox rows already in `matched` / `bounce` state are skipped for
 * Notion side effects, but we still sync `outbound_messages.thread_status` when
 * reconcile linked inbox without updating status (historical backfill).
 */

import { Worker, type Job } from "bullmq";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../queues/connection.js";
import { QUEUE_NAMES, type MatchJobData } from "../queues/queues.js";
import { findInboxById, markInboxIgnored, markInboxMatched } from "../db/repositories/inbox.repo.js";
import { findMailboxById } from "../db/repositories/mailbox.repo.js";
import { resolveInboundOutboundMatch } from "../services/reply-matcher.service.js";
import { detectBounce } from "../services/bounce-detector.service.js";
import { extractFailedRecipientEmails } from "../services/bounce-matcher.service.js";
import { detectReplyKind } from "../services/auto-reply-detector.service.js";
import { getMessageInternetHeaders } from "../graph/mail.service.js";
import {
  markOutboundBounce,
  markOutboundReplyReceived,
  findOutboundById,
} from "../services/message-store.service.js";
import { upsertConversation } from "../db/repositories/conversation.repo.js";
import { markDtcKeyPersonEmailFailedOnBounce } from "../notion/dtc-send.js";
import { createInboundReplyRow, markOriginalReplyDone, writeBounce } from "../notion/writer.js";
import { getPage } from "../notion/client.js";
import { extractCrmFromInteractionLogPage } from "../notion/crm-snapshot.js";
import { updateInboxCrmFields } from "../db/repositories/inbox.repo.js";

import type { CrmSnapshot } from "../notion/crm-snapshot.js";
import type { InboxMessage } from "../db/schema/inbox_messages.js";
import type { MatchResult } from "../services/reply-matcher.service.js";

let worker: Worker<MatchJobData> | null = null;

/** 当 Notion 未返回 CRM 时用于与 outbound 行合并。 */
const EMPTY_CRM: CrmSnapshot = {
  keyPersonId: null,
  keyPersonName: null,
  keyPersonNotionUrl: null,
  entityName: null,
  entityNotionUrl: null,
};

/** Notion 优先；缺省字段用 `outbound_messages`（含回填写入的 URL）补上。 */
function mergeCrmNotionThenOutbound(notion: CrmSnapshot, ob: Awaited<ReturnType<typeof findOutboundById>>): CrmSnapshot {
  if (!ob) return notion;
  const pick = (n: string | null, p: string | null | undefined) =>
    n != null && String(n).trim() !== "" ? n : p != null && String(p).trim() !== "" ? String(p).trim() : null;
  return {
    keyPersonId: pick(notion.keyPersonId, ob.keyPersonId),
    keyPersonName: pick(notion.keyPersonName, ob.keyPersonName),
    keyPersonNotionUrl: pick(notion.keyPersonNotionUrl, ob.keyPersonNotionUrl),
    entityName: pick(notion.entityName, ob.entityName),
    entityNotionUrl: pick(notion.entityNotionUrl, ob.entityNotionUrl),
  };
}

/** Refresh inbox CRM from parent IL (DTC relations) + matched outbound row. */
async function syncInboxCrmFromMatch(
  inboxRowId: number,
  outboundId: number,
  notionPageId: string | null | undefined,
): Promise<{ crm: CrmSnapshot; ob: Awaited<ReturnType<typeof findOutboundById>> }> {
  let notionCrm: CrmSnapshot = EMPTY_CRM;
  if (notionPageId) {
    try {
      const parentPage = await getPage(notionPageId);
      notionCrm = await extractCrmFromInteractionLogPage(parentPage, loadConfig());
    } catch (err) {
      logger.warn({ err, inboxRowId, notionPageId }, "match: CRM snapshot from Notion failed");
    }
  }
  const ob = await findOutboundById(outboundId);
  const crm = mergeCrmNotionThenOutbound(notionCrm, ob);
  await updateInboxCrmFields(inboxRowId, crm);
  return { crm, ob };
}

/** Reconcile 可能已写 inbox 关联但未更新 outbound.thread_status。 */
async function syncOutboundThreadStatusFromFinalizedInbox(
  row: InboxMessage,
  bounce: ReturnType<typeof detectBounce>,
): Promise<void> {
  if (!row.matchedOutboundId) return;
  const ob = await findOutboundById(row.matchedOutboundId);
  if (!ob || ob.threadStatus !== "sent") return;

  if (row.matchStatus === "bounce") {
    const reason =
      bounce.isBounce
        ? `${bounce.reason}; subject="${row.subject}"; from=${row.fromEmail}`
        : `reconcile bounce; subject="${row.subject}"; from=${row.fromEmail}`;
    await markOutboundBounce(ob.id, reason);
    logger.info({ inboxRowId: row.id, outboundId: ob.id }, "match: synced outbound bounce from finalized inbox");
    return;
  }

  if (row.matchStatus === "matched") {
    await markOutboundReplyReceived(ob.id);
    logger.info({ inboxRowId: row.id, outboundId: ob.id }, "match: synced outbound reply_received from finalized inbox");
  }
}

function formatBounceReason(
  bounce: ReturnType<typeof detectBounce>,
  row: InboxMessage,
  mailboxEmail: string,
): string {
  const failed = extractFailedRecipientEmails(
    { subject: row.subject, bodyPreview: row.bodyPreview },
    mailboxEmail,
  );
  const failedPart = failed.length ? `; failedRecipient=${failed.join(",")}` : "";
  const preview = row.bodyPreview?.trim().replace(/\s+/g, " ").slice(0, 200);
  const previewPart = preview ? `; ndrPreview="${preview}"` : "";
  return `${bounce.reason}; subject="${row.subject}"; from=${row.fromEmail}${failedPart}${previewPart}`;
}

async function applyOutboundThreadStatus(
  matched: MatchResult,
  bounce: ReturnType<typeof detectBounce>,
  row: InboxMessage,
  mailboxEmail: string,
): Promise<void> {
  if (!matched.outboundId) return;
  if (bounce.isBounce) {
    const reason = formatBounceReason(bounce, row, mailboxEmail);
    await markOutboundBounce(matched.outboundId, reason);
    return;
  }
  await markOutboundReplyReceived(matched.outboundId);
}

async function processMatch(job: Job<MatchJobData>): Promise<void> {
  const row = await findInboxById(job.data.inboxRowId);
  if (!row) {
    logger.warn({ inboxRowId: job.data.inboxRowId }, "match: inbox row not found, skipping");
    return;
  }

  const bounce = detectBounce({ fromEmail: row.fromEmail, subject: row.subject });

  // Idempotency guard. Since we now CREATE a child Notion row (instead of
  // patching the parent), re-running on a row whose match_status is already
  // matched/bounce would produce a duplicate. Skip those.
  if (row.matchStatus === "matched" || row.matchStatus === "bounce" || row.matchStatus === "auto_reply") {
    await syncOutboundThreadStatusFromFinalizedInbox(row, bounce);
    logger.debug(
      { inboxRowId: row.id, matchStatus: row.matchStatus },
      "match: inbox row already finalized, skipping side effects",
    );
    return;
  }

  const mailbox = await findMailboxById(row.mailboxId);
  const mailboxEmail = mailbox?.email ?? "";

  const matched = await resolveInboundOutboundMatch(
    {
      mailboxId: row.mailboxId,
      conversationId: row.conversationId,
      subject: row.subject,
      fromEmail: row.fromEmail,
      recipientsJson: row.recipientsJson,
      receivedAt: row.receivedAt,
      bodyPreview: row.bodyPreview,
    },
    mailboxEmail,
  );

  if (!matched.matched) {
    if (bounce.isBounce) {
      logger.warn(
        {
          inboxRowId: row.id,
          conversationId: row.conversationId,
          subject: row.subject,
          from: row.fromEmail,
          reason: matched.reason,
        },
        "match: bounce detected but no outbound found",
      );
    }
    await markInboxIgnored(row.id);
    return;
  }

  if (bounce.isBounce && matched.outboundId) {
    const bounceReason = formatBounceReason(bounce, row, mailboxEmail);
    await markOutboundBounce(matched.outboundId, bounceReason);
    const { crm } = await syncInboxCrmFromMatch(row.id, matched.outboundId, matched.notionPageId);
    if (matched.notionPageId) {
      await markInboxMatched(row.id, matched.outboundId, "bounce");
      await upsertConversation(row.conversationId, matched.notionPageId, row.id, row.receivedAt);
      await writeBounce(matched.notionPageId, {
        reason: bounceReason,
        inboundMessageId: row.graphMessageId,
        inboundConversationId: row.conversationId,
        receivedAt: row.receivedAt,
      });
      const cfg = loadConfig();
      try {
        const kpMark = await markDtcKeyPersonEmailFailedOnBounce(cfg, {
          ilNotionPageId: matched.notionPageId,
          keyPersonNotionUrl: crm.keyPersonNotionUrl,
        });
        if (kpMark.updated) {
          logger.info(
            {
              notionPageId: matched.notionPageId,
              keyPersonPageId: kpMark.keyPersonPageId,
              status: kpMark.status,
              source: kpMark.source,
            },
            "match: DTC Key Person Email Verified Status set after bounce",
          );
        } else {
          logger.warn(
            { notionPageId: matched.notionPageId, inboxRowId: row.id, source: kpMark.source },
            "match: DTC Key Person Email Verified Status not updated (no Key Person page resolved)",
          );
        }
      } catch (err) {
        logger.error(
          { err, notionPageId: matched.notionPageId, inboxRowId: row.id },
          "match: DTC Key Person Email Verified Status update failed after bounce",
        );
      }
    } else {
      await markInboxMatched(row.id, matched.outboundId, "bounce");
      try {
        const kpMark = await markDtcKeyPersonEmailFailedOnBounce(loadConfig(), {
          keyPersonNotionUrl: crm.keyPersonNotionUrl,
        });
        if (kpMark.updated) {
          logger.info(
            { keyPersonPageId: kpMark.keyPersonPageId, status: kpMark.status, inboxRowId: row.id },
            "match: DTC Key Person Email Verified Status set after bounce (no IL page)",
          );
        }
      } catch (err) {
        logger.error(
          { err, inboxRowId: row.id, outboundId: matched.outboundId },
          "match: DTC Key Person Email Verified Status update failed after bounce (no IL page)",
        );
      }
    }
    logger.info(
      { inboxRowId: row.id, outboundId: matched.outboundId, method: matched.method },
      "match: bounce written",
    );
    return;
  }

  if (!matched.outboundId) return;

  let headers: Array<{ name: string; value: string }> = [];
  if (mailboxEmail) {
    try {
      headers = await getMessageInternetHeaders(mailboxEmail, row.graphMessageId);
    } catch (err) {
      logger.warn({ err, inboxRowId: row.id }, "match: failed to fetch internetMessageHeaders; using subject/body only");
    }
  }
  const replyKind = detectReplyKind({
    subject: row.subject,
    bodyPreview: row.bodyPreview,
    headers,
  });

  if (replyKind.kind === "auto") {
    await syncInboxCrmFromMatch(row.id, matched.outboundId, matched.notionPageId);
    await markInboxMatched(row.id, matched.outboundId, "auto_reply");
    await upsertConversation(row.conversationId, matched.notionPageId ?? null, row.id, row.receivedAt);
    logger.info(
      {
        inboxRowId: row.id,
        outboundId: matched.outboundId,
        reason: replyKind.reason,
        method: matched.method,
      },
      "match: auto-reply detected — skipped human-reply side effects",
    );
    return;
  }

  await applyOutboundThreadStatus(matched, bounce, row, mailboxEmail);
  await syncInboxCrmFromMatch(row.id, matched.outboundId, matched.notionPageId);
  await markInboxMatched(row.id, matched.outboundId, "matched");
  await upsertConversation(row.conversationId, matched.notionPageId ?? null, row.id, row.receivedAt);

  if (matched.notionPageId) {
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
        method: matched.method,
        replyKind: replyKind.kind,
      },
      "match: inbound-reply child row created",
    );
  } else {
    logger.info(
      { inboxRowId: row.id, outboundId: matched.outboundId, method: matched.method },
      "match: inbound matched outbound with no Notion page — skipping Notion child row",
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
