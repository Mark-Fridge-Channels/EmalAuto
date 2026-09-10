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
import { buildSendJobFromNotion, resolveOutboundBodyHtml } from "../services/job-builder.service.js";
import { resolveDtcOutboundSend } from "../notion/dtc-send.js";
import {
  isCampaignHistoryPage,
  resolveCampaignOutboundSend,
} from "../campaign/resolve-send.js";
import { resolveCampaignCopy } from "../campaign/render-for-send.js";
import { lockActiveKeyPersonAfterSend } from "../campaign/lifecycle.js";
import { findRecentSentMessage, sendMail, sendMailReplyInThread, type SentItemsLookupHit } from "../graph/mail.service.js";
import { findMailboxByEmail } from "../db/repositories/mailbox.repo.js";
import { recordOutbound, updateOutboundBody } from "../services/message-store.service.js";
import { markSending, writeSendFailure, writeSendSuccess } from "../notion/writer.js";
import { getPage, updatePage } from "../notion/client.js";
import {
  extractCrmFromDtcPageIds,
  extractCrmFromInteractionLogPage,
} from "../notion/crm-snapshot.js";
import { updateOutboundCrmFields } from "../db/repositories/outbound.repo.js";
import { coercePlainTextToHtml, ensureOutboundMailBody } from "../services/mail-signature.service.js";
import {
  buildUnsubscribeUrl,
  canIssueListUnsubscribeHeaders,
  createUnsubscribeToken,
} from "../services/list-unsubscribe.service.js";
import {
  buildOpenPixelUrl,
  canIssueOpenTracking,
  createOpenTrackToken,
  injectOpenPixel,
} from "../services/open-tracking.service.js";
import { notionRichText } from "../notion/property-mapper.js";
import { sleep } from "../utils/sleep.js";
import type { CampaignSendBundle } from "../campaign/resolve-send.js";

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
  let campaignBundle: CampaignSendBundle | undefined;
  if (built.actionType === "send" && !isReplyInThread) {
    const cfg = loadConfig();
    const page = await getPage(notionPageId);
    if (isCampaignHistoryPage(page)) {
      const campCheck = await resolveCampaignOutboundSend(page, cfg);
      if (!campCheck.ok) {
        await softFail(campCheck.reason);
        return;
      }
      campaignBundle = campCheck.bundle;
      draft.to = [campCheck.bundle.recipientEmail];
      try {
        const rendered = await resolveCampaignCopy({
          historyPage: page,
          subject: draft.subject,
          body: draft.bodyHtml,
          bundle: campCheck.bundle,
          fromMailbox: draft.fromMailbox,
        });
        draft.subject = rendered.subject;
        draft.bodyHtml = rendered.body.includes("<")
          ? rendered.body
          : rendered.body.replace(/\n/g, "<br>");
        draft.isHtml = true;
        if (rendered.usedTemplate) {
          await updatePage(notionPageId, {
            [cfg.notion.property_names.subject]: notionRichText(rendered.subject),
            [cfg.notion.property_names.body]: notionRichText(rendered.body),
          });
          logger.info(
            { notionPageId, templatePageId: rendered.templatePageId },
            "send: rendered Subject/Body from Campaign template",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await softFail(msg);
        return;
      }
    } else {
      const dtcCheck = await resolveDtcOutboundSend(page, cfg);
      if (!dtcCheck.ok) {
        await softFail(dtcCheck.reason);
        return;
      }
      draft.to = [dtcCheck.bundle.recipientEmail];
      built.dtc = dtcCheck.bundle;
    }
  }

  if (!isReplyInThread && draft.to.length === 0) {
    await softFail(
      built.actionType === "send"
        ? "missing recipient (Key Person Email / gate failed)"
        : "missing recipient (no Payload.to_email / Reply Email)",
    );
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
  const cfg = loadConfig();
  draft.bodyHtml = ensureOutboundMailBody(
    draft.bodyHtml,
    draft.fromMailbox,
    draft.isHtml !== false,
    cfg.mail.opt_out_footer_text,
  );

  if (built.actionType === "send" && !isReplyInThread && draft.to[0]) {
    const publicBase = cfg.mail.list_unsubscribe_public_base_url.trim();
    const secret = cfg.mail.list_unsubscribe_token_secret.trim();
    if (!canIssueListUnsubscribeHeaders(publicBase)) {
      logger.warn(
        { notionPageId, publicBase: publicBase || "(empty)" },
        "send: skipping List-Unsubscribe — set LIST_UNSUBSCRIBE_PUBLIC_BASE_URL or V2_PUBLIC_BASE_URL to https://",
      );
    } else if (secret.length < 8) {
      logger.warn({ notionPageId }, "send: skipping List-Unsubscribe headers — token secret too short");
    } else {
      const token = createUnsubscribeToken(
        { recipientEmail: draft.to[0], notionPageId },
        secret,
        cfg.mail.list_unsubscribe_token_ttl_days * 24 * 60 * 60,
      );
      draft.listUnsubscribeUrl = buildUnsubscribeUrl({
        publicBaseUrl: publicBase,
        unsubscribePath: cfg.mail.list_unsubscribe_path,
        token,
      });
      draft.bodyHtml = coercePlainTextToHtml(draft.bodyHtml);
      draft.isHtml = true;
      logger.info(
        { notionPageId, to: draft.to[0], unsubUrlPrefix: publicBase },
        "send: MIME outbound with List-Unsubscribe + List-Unsubscribe-Post",
      );
    }

    if (
      canIssueOpenTracking({
        enabled: cfg.mail.open_tracking_enabled,
        publicBaseUrl: publicBase,
        secret,
      })
    ) {
      draft.bodyHtml = coercePlainTextToHtml(draft.bodyHtml);
      draft.isHtml = true;
      const openToken = createOpenTrackToken(
        { recipientEmail: draft.to[0], notionPageId },
        secret,
        cfg.mail.open_tracking_token_ttl_days * 24 * 60 * 60,
      );
      const pixelUrl = buildOpenPixelUrl({
        publicBaseUrl: publicBase,
        openPath: cfg.mail.open_tracking_path,
        token: openToken,
      });
      draft.bodyHtml = injectOpenPixel(draft.bodyHtml, pixelUrl);
      logger.info(
        { notionPageId, to: draft.to[0], openPath: cfg.mail.open_tracking_path },
        "send: injected open-tracking pixel",
      );
    } else if (cfg.mail.open_tracking_enabled) {
      logger.warn(
        { notionPageId, publicBase: publicBase || "(empty)" },
        "send: skipping open pixel — need https public base + token secret (≥8)",
      );
    }
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
        cc: draft.cc?.length ? draft.cc : undefined,
        bcc: draft.bcc?.length ? draft.bcc : undefined,
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
    let outboundBody = draft.bodyHtml?.trim() ?? "";
    if (!outboundBody) {
      try {
        const page = await getPage(notionPageId);
        outboundBody = resolveOutboundBodyHtml(
          page.properties as Record<string, unknown>,
          built.actionType,
          loadConfig(),
        );
      } catch (err) {
        logger.warn({ err, notionPageId }, "send: could not re-read body from Notion for PG persist");
      }
    }

    const inserted = await recordOutbound({
      mailboxId: mailbox.id,
      notionPageId,
      graphMessageId: hit.graphMessageId,
      internetMessageId: hit.internetMessageId,
      conversationId: hit.conversationId,
      subject: hit.subject,
      body: outboundBody,
      sentAt,
      recipientsJson: { to: draft.to, cc: draft.cc ?? [], bcc: draft.bcc ?? [] } as any,
      metaJson: { actionType: built.actionType } as any,
      threadStatus: "sent",
    });

    if (!inserted.body?.trim() && outboundBody) {
      await updateOutboundBody(inserted.id, outboundBody);
    } else if (!outboundBody) {
      logger.warn(
        { notionPageId, outboundId: inserted.id, actionType: built.actionType },
        "send: outbound_messages.body is empty after send",
      );
    }

    try {
      const cfg = loadConfig();
      const crm = campaignBundle
        ? await extractCrmFromDtcPageIds(cfg, {
            keyPersonPageId: campaignBundle.keyPersonPageId,
          })
        : built.dtc
          ? await extractCrmFromDtcPageIds(cfg, {
              entityPageId: built.dtc.entityPageId,
              keyPersonPageId: built.dtc.keyPersonPageId,
            })
          : await extractCrmFromInteractionLogPage(await getPage(notionPageId), cfg);
      if (campaignBundle?.companyName) {
        crm.entityName = crm.entityName || campaignBundle.companyName;
      }
      await updateOutboundCrmFields(inserted.id, crm);
    } catch (err) {
      logger.warn({ err, notionPageId, outboundId: inserted.id }, "send: optional CRM snapshot failed");
    }

    await writeSendSuccess(notionPageId, {
      graphMessageId: hit.graphMessageId,
      conversationId: hit.conversationId,
      internetMessageId: hit.internetMessageId,
      sentAt,
    });

    if (campaignBundle) {
      await lockActiveKeyPersonAfterSend(notionPageId).catch((err) =>
        logger.warn({ err, notionPageId }, "send: lock active KP failed"),
      );
    }

    logger.info(
      {
        notionPageId,
        from: draft.fromMailbox,
        to: draft.to,
        conversationId: hit.conversationId,
        status: loadConfig().notion.status_values.success,
        campaign: Boolean(campaignBundle),
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
