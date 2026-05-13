/**
 * Writes outcomes back to the same Notion DB minimal-server uses.
 *
 * Conventions:
 * - Status column may be `status` OR `select` — adapt per page.
 * - Graph metadata is merged into the existing `Payload` JSON under `_graph`.
 * - Times that are user-facing (`Last Reply Time`) use Asia/Shanghai +08:00,
 *   matching minimal-server.
 */

import { logger } from "../utils/logger.js";
import { loadConfig } from "../config/index.js";
import { getPage, updatePage, type NotionPage } from "./client.js";
import {
  buildPropertyResolver,
  notionDate,
  notionDateTimeAsiaShanghai,
  notionEmail,
  notionRichText,
  statusOrSelect,
} from "./property-mapper.js";

interface SendSuccessUpdate {
  graphMessageId: string;
  conversationId: string;
  internetMessageId: string | null;
  sentAt: Date;
}

interface SendFailureUpdate {
  errorText: string;
}

interface BounceUpdate {
  reason: string;
  inboundMessageId: string;
  inboundConversationId: string;
  receivedAt: Date;
}

interface ReplyUpdate {
  replyBodyText: string;
  replyFromEmail: string;
  receivedAt: Date;
  /** Graph message `id` of the inbound mail in this mailbox — enables Notion "Reply" rows to use `createReply`. */
  replyAnchorGraphMessageId: string;
}

/** Read-modify-write merge into the `Payload` rich_text column (JSON). */
async function mergePayload(
  page: NotionPage,
  patch: Record<string, unknown>,
): Promise<{ propertyName: string; value: unknown }> {
  const cfg = loadConfig();
  const { pick } = buildPropertyResolver(cfg);
  const payloadProp = pick(page.properties, "payload") as any;
  const colName = cfg.notion.property_names.payload;
  let current: Record<string, unknown> = {};
  const raw = payloadProp?.rich_text?.[0]?.plain_text ?? "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // keep current = {}
      logger.warn({ pageId: page.id }, "payload not valid JSON, will overwrite under _graph only");
    }
  }
  const merged = { ...current, ...patch };
  return { propertyName: colName, value: notionRichText(JSON.stringify(merged)) };
}

/** Mark Notion row as currently sending (lets ops see in-flight rows). */
export async function markSending(notionPageId: string): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  const { pick } = buildPropertyResolver(cfg);
  const statusProp = pick(page.properties, "Status");
  const statusColName = cfg.notion.property_names.Status;

  await updatePage(notionPageId, {
    [statusColName]: statusOrSelect(statusProp, cfg.notion.status_values.in_flight),
  });
}

export async function writeSendSuccess(
  notionPageId: string,
  upd: SendSuccessUpdate,
): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  const { pick } = buildPropertyResolver(cfg);
  const statusProp = pick(page.properties, "Status");
  const statusColName = cfg.notion.property_names.Status;
  const completionColName = cfg.notion.property_names.completion_time;

  const mergedPayload = await mergePayload(page, {
    _graph: {
      messageId: upd.graphMessageId,
      conversationId: upd.conversationId,
      internetMessageId: upd.internetMessageId,
      sentAt: upd.sentAt.toISOString(),
    },
  });

  await updatePage(notionPageId, {
    [statusColName]: statusOrSelect(statusProp, cfg.notion.status_values.success),
    [completionColName]: notionDate(upd.sentAt),
    [mergedPayload.propertyName]: mergedPayload.value,
  });

  // Verify the status actually landed in Notion. Read-after-write is normally
  // immediate, but we retry briefly because Notion's index can lag a beat.
  const expected = cfg.notion.status_values.success;
  let attempt = 0;
  for (;;) {
    const verifyPage = await getPage(notionPageId);
    const sp = pick(verifyPage.properties, "Status");
    const actual = sp?.type === "status" ? sp.status?.name : sp?.select?.name;
    if (actual === expected) return;
    attempt += 1;
    if (attempt >= 3) {
      logger.error(
        { notionPageId, expected, actual, attempts: attempt },
        "writeSendSuccess: status did not persist as Success",
      );
      throw new Error(
        `Notion Status verify failed: expected "${expected}", got "${actual ?? "(unset)"}"`,
      );
    }
    logger.warn(
      { notionPageId, expected, actual, attempt },
      "writeSendSuccess: status mismatch, retrying write",
    );
    // best-effort re-write before next verify read
    await updatePage(notionPageId, {
      [statusColName]: statusOrSelect(statusProp, expected),
    });
  }
}

export async function writeSendFailure(
  notionPageId: string,
  upd: SendFailureUpdate,
): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  const { pick } = buildPropertyResolver(cfg);
  const statusProp = pick(page.properties, "Status");
  const statusColName = cfg.notion.property_names.Status;
  const remarkColName = cfg.notion.property_names.result_remark;

  await updatePage(notionPageId, {
    [statusColName]: statusOrSelect(statusProp, cfg.notion.status_values.failure),
    [remarkColName]: notionRichText(upd.errorText),
  });
}

export async function writeBounce(notionPageId: string, upd: BounceUpdate): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  const { pick } = buildPropertyResolver(cfg);
  const statusProp = pick(page.properties, "Status");
  const statusColName = cfg.notion.property_names.Status;
  const remarkColName = cfg.notion.property_names.result_remark;

  const mergedPayload = await mergePayload(page, {
    _graph_bounce: {
      reason: upd.reason,
      inboundMessageId: upd.inboundMessageId,
      inboundConversationId: upd.inboundConversationId,
      receivedAt: upd.receivedAt.toISOString(),
    },
  });

  await updatePage(notionPageId, {
    [statusColName]: statusOrSelect(statusProp, cfg.notion.status_values.failure),
    [remarkColName]: notionRichText(upd.reason),
    [mergedPayload.propertyName]: mergedPayload.value,
  });
}

export async function writeReply(notionPageId: string, upd: ReplyUpdate): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  const replyBodyCol = cfg.notion.property_names.reply_body;
  const replyEmailCol = cfg.notion.property_names.reply_email;
  const lastReplyTimeCol = cfg.notion.property_names.last_reply_time;

  const mergedPayload = await mergePayload(page, {
    replyToGraphMessageId: upd.replyAnchorGraphMessageId,
  });

  await updatePage(notionPageId, {
    [replyBodyCol]: notionRichText(upd.replyBodyText),
    [replyEmailCol]: notionEmail(upd.replyFromEmail),
    [lastReplyTimeCol]: notionDateTimeAsiaShanghai(upd.receivedAt),
    [mergedPayload.propertyName]: mergedPayload.value,
  });
}
