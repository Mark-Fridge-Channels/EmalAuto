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
import {
  createPageInDatabase,
  getPage,
  retrieveDatabase,
  updatePage,
  type NotionPage,
} from "./client.js";
import {
  buildPropertyResolver,
  notionDate,
  notionDateTimeAsiaShanghai,
  notionEmail,
  notionRichText,
  notionSelect,
  notionStatus,
  notionTitle,
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

interface InboundReplyRow {
  /** Outbound row this inbound reply belongs to — used for back-reference + Reply Status stamp. */
  parentOutboundNotionPageId: string;
  /** Local mailbox (UPN) that received the reply. */
  receivingMailbox: string;
  /** Customer email that sent the reply. */
  fromEmail: string;
  /** Subject of the inbound message ("Re: …" etc.) — copied into Outreach Subject. */
  subject: string;
  /** Body preview (rich_text in Notion). */
  bodyPreview: string;
  /** Anchor message id for future `createReply` calls (Graph message id in the receiving mailbox). */
  replyAnchorGraphMessageId: string;
  /** Conversation id (Graph) for cross-referencing with outbound_messages. */
  conversationId: string;
  /** Internet Message-ID header of the inbound (for ops debugging). */
  internetMessageId?: string | null;
  receivedAt: Date;
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

/* ---------------- Inbound-reply: NEW row + parent stamp ---------------- */

let cachedTitlePropertyName: string | null = null;

/** Discover (and cache) the database's single title property name. */
async function getTitlePropertyName(): Promise<string> {
  if (cachedTitlePropertyName) return cachedTitlePropertyName;
  const cfg = loadConfig();
  const db = await retrieveDatabase(cfg.notion.database_id);
  for (const [name, def] of Object.entries(db.properties)) {
    if ((def as { type?: string }).type === "title") {
      cachedTitlePropertyName = name;
      return name;
    }
  }
  throw new Error("notion: database has no title property — cannot create inbound-reply row");
}

/**
 * Create a new Notion row that records an inbound reply as a standalone task.
 *
 * The row purposefully does NOT set OutReach Status, so the poller will not
 * try to send it. To trigger a same-thread reply later, the user only has to:
 *   1. Action = NOTION_ACTION_REPLY (e.g. "Reply Email")
 *   2. InNOut = NOTION_IN_N_OUT_VALUE (e.g. "Out")
 *   3. OutReach Status = NOTION_STATUS_TODO (e.g. "Todo")
 *   4. Fill Outreach Body + Trigger Time
 * The Payload's `replyToGraphMessageId` (set here) drives the in-thread send.
 */
export async function createInboundReplyRow(row: InboundReplyRow): Promise<string> {
  const cfg = loadConfig();
  const p = cfg.notion.property_names;
  const titleColName = await getTitlePropertyName();

  const titleText = `[Inbound Reply] ${row.subject || "(no subject)"}`.slice(0, 1900);
  const payloadObj = {
    actionType: "inbound_reply" as const,
    replyKind: "human" as const,
    replyToGraphMessageId: row.replyAnchorGraphMessageId,
    conversationId: row.conversationId,
    internetMessageId: row.internetMessageId ?? null,
    receivedAt: row.receivedAt.toISOString(),
    parentOutboundNotionPageId: row.parentOutboundNotionPageId,
    to_email: row.fromEmail,
    fromMailbox: row.receivingMailbox,
  };

  const properties: Record<string, unknown> = {
    [titleColName]: notionTitle(titleText),
    [p.Action]: notionSelect(cfg.notion.action_values.inbound_reply),
    [p.Platform]: notionSelect(cfg.notion.platform_value),
    [p.InNOut]: notionSelect(cfg.notion.in_n_out_inbound_value),
    [p.sender_email]: notionRichText(row.receivingMailbox),
    [p.subject]: notionRichText(row.subject),
    [p.reply_body]: notionRichText(row.bodyPreview),
    [p.reply_email]: notionEmail(row.fromEmail),
    [p.last_reply_time]: notionDateTimeAsiaShanghai(row.receivedAt),
    [p.payload]: notionRichText(JSON.stringify(payloadObj)),
    [p.task_id]: notionRichText(`inbound__${row.replyAnchorGraphMessageId}`),
  };

  const created = await createPageInDatabase(cfg.notion.database_id, properties);
  logger.info(
    {
      newNotionPageId: created.id,
      parentOutboundNotionPageId: row.parentOutboundNotionPageId,
      receivingMailbox: row.receivingMailbox,
      fromEmail: row.fromEmail,
    },
    "inbound reply: child Notion row created",
  );
  return created.id;
}

/** Stamp the original outbound row's Reply Status (e.g. "Done") after a child row is created. */
export async function markOriginalReplyDone(parentOutboundNotionPageId: string): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(parentOutboundNotionPageId);
  const { pick } = buildPropertyResolver(cfg);
  const replyStatusProp = pick(page.properties, "reply_status");
  const replyStatusCol = cfg.notion.property_names.reply_status;

  await updatePage(parentOutboundNotionPageId, {
    [replyStatusCol]: statusOrSelect(replyStatusProp, cfg.notion.reply_status_values.done),
  });
}

function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WebReplyNotionDraft {
  receivingMailbox: string;
  counterpartyEmail: string;
  subject: string;
  bodyHtml: string;
  replyAnchorGraphMessageId: string;
  conversationId: string;
  /** When known, links the manual reply to the original outbound Notion task. */
  parentOutboundNotionPageId: string | null;
}

/**
 * Creates a **Success** Notion row (Action = Reply Email) so the poller never
 * enqueues it, then the caller sends via Graph and runs `writeSendSuccess`.
 */
export async function createWebReplyNotionPage(draft: WebReplyNotionDraft): Promise<string> {
  const cfg = loadConfig();
  const p = cfg.notion.property_names;
  const titleColName = await getTitlePropertyName();
  const now = new Date();
  const dbMeta = await retrieveDatabase(cfg.notion.database_id);
  const statusCol = p.Status;
  const statusType = (dbMeta.properties[statusCol] as { type?: string } | undefined)?.type;
  const statusPayload =
    statusType === "status"
      ? notionStatus(cfg.notion.status_values.success)
      : notionSelect(cfg.notion.status_values.success);

  const plainBody = stripHtml(draft.bodyHtml).slice(0, 1990);
  const payloadObj = {
    actionType: "web_console_reply" as const,
    replyToGraphMessageId: draft.replyAnchorGraphMessageId,
    conversationId: draft.conversationId,
    to_email: draft.counterpartyEmail,
    fromMailbox: draft.receivingMailbox,
    ...(draft.parentOutboundNotionPageId
      ? { parentOutboundNotionPageId: draft.parentOutboundNotionPageId }
      : {}),
  };
  const taskId = `webreply__${draft.replyAnchorGraphMessageId}__${now.getTime()}`;

  const properties: Record<string, unknown> = {
    [titleColName]: notionTitle(`[Web Reply] ${(draft.subject || "(no subject)").slice(0, 1800)}`),
    [p.Action]: notionSelect(cfg.notion.action_values.reply),
    [statusCol]: statusPayload,
    [p.Platform]: notionSelect(cfg.notion.platform_value),
    [p.InNOut]: notionSelect(cfg.notion.in_n_out_value),
    [p.sender_email]: notionRichText(draft.receivingMailbox),
    [p.subject]: notionRichText(draft.subject.slice(0, 1900)),
    [p.body]: notionRichText(plainBody || "(empty)"),
    [p.reply_email]: notionEmail(draft.counterpartyEmail),
    [p.last_reply_time]: notionDateTimeAsiaShanghai(now),
    [p.payload]: notionRichText(JSON.stringify(payloadObj)),
    [p.task_id]: notionRichText(taskId),
    [p.trigger_time]: notionDateTimeAsiaShanghai(now),
  };

  const created = await createPageInDatabase(cfg.notion.database_id, properties);
  logger.info({ newNotionPageId: created.id }, "web reply: notion row created (pre-send, Success)");
  return created.id;
}
