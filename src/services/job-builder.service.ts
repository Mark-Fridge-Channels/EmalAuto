/**
 * Translate a Notion send-row into a concrete OutboundDraft.
 *
 * Mirrors minimal-server/queueParser.parseQueueRow shape:
 * - subject comes from `Outreach Subject` column (with rich_text → HTML on body)
 * - recipient may come from `Reply Email` column OR `Payload.to_email` / `to`
 * - sender comes from `FCAccount`
 *
 * Strictly read-only against Notion.
 */

import { loadConfig } from "../config/index.js";
import { getPage } from "../notion/client.js";
import { resolveDtcOutboundSend, type DtcSendBundle } from "../notion/dtc-send.js";
import {
  buildPropertyResolver,
  normalizeEmail,
  readEmail,
  readRichText,
  readSelectOrStatus,
  richTextPropertyToHtml,
} from "../notion/property-mapper.js";
import type { OutboundDraft } from "../graph/mail.service.js";

export interface BuiltSendJob {
  notionPageId: string;
  draft: OutboundDraft;
  /** `send` or `reply` — preserved for future reply-flow logic. */
  actionType: "send" | "reply" | "unknown";
  /** Set when Action = Send Email and DTC gate + recipient resolve succeeded. */
  dtc?: DtcSendBundle;
}

export async function buildSendJobFromNotion(notionPageId: string): Promise<BuiltSendJob> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  const { pick } = buildPropertyResolver(cfg);

  const senderEmail = normalizeEmail(readRichText(pick(page.properties, "sender_email")));
  const subject = readRichText(pick(page.properties, "subject"));

  // Body: prefer rich_text → HTML to preserve links; fall back to Payload.body.
  const bodyProp = pick(page.properties, "body") as any;
  let bodyHtml = "";
  if (bodyProp?.type === "rich_text") {
    bodyHtml = richTextPropertyToHtml(bodyProp);
  }

  // Recipients: payload JSON > Reply Email column.
  const payloadText = readRichText(pick(page.properties, "payload"));
  let payload: any = null;
  if (payloadText) {
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = null;
    }
  }
  const replyEmailColumn = readEmail(pick(page.properties, "reply_email"));
  const toCandidates: string[] = [];
  if (Array.isArray(payload?.to)) for (const v of payload.to) toCandidates.push(String(v));
  else if (payload?.to) toCandidates.push(String(payload.to));
  if (payload?.to_email) toCandidates.push(String(payload.to_email));
  if (payload?.counterpartyEmail) toCandidates.push(String(payload.counterpartyEmail));
  if (replyEmailColumn) toCandidates.push(replyEmailColumn);
  const to = toCandidates
    .map(normalizeEmail)
    .filter((e) => /@/.test(e));

  // CC / BCC: optional from payload only.
  const ccs = Array.isArray(payload?.cc)
    ? payload.cc.map((v: unknown) => normalizeEmail(String(v))).filter((e: string) => /@/.test(e))
    : [];
  const bccs = Array.isArray(payload?.bcc)
    ? payload.bcc.map((v: unknown) => normalizeEmail(String(v))).filter((e: string) => /@/.test(e))
    : [];

  // Fallback body source: payload.body / payload.bodyHtml
  if (!bodyHtml) {
    bodyHtml =
      (typeof payload?.bodyHtml === "string" && payload.bodyHtml) ||
      (typeof payload?.body === "string" && payload.body) ||
      "";
  }

  const actionName = readSelectOrStatus(pick(page.properties, "Action"));
  const actionType: BuiltSendJob["actionType"] =
    actionName === cfg.notion.action_values.send
      ? "send"
      : actionName === cfg.notion.action_values.reply
        ? "reply"
        : "unknown";

  const replyToGraphMessageId =
    typeof payload?.replyToGraphMessageId === "string" ? payload.replyToGraphMessageId.trim() : "";

  const draft: OutboundDraft = {
    fromMailbox: senderEmail,
    to,
    cc: ccs,
    bcc: bccs,
    subject,
    bodyHtml,
    isHtml: bodyHtml.includes("<"),
    ...(replyToGraphMessageId ? { replyToGraphMessageId } : {}),
  };

  let dtc: DtcSendBundle | undefined;
  if (actionType === "send") {
    const resolved = await resolveDtcOutboundSend(page, cfg);
    if (resolved.ok) {
      dtc = resolved.bundle;
      draft.to = [resolved.bundle.recipientEmail];
    }
  }

  return { notionPageId, draft, actionType, ...(dtc ? { dtc } : {}) };
}
