/**
 * Translate a Notion send-row into a concrete OutboundDraft.
 *
 * Mirrors minimal-server/queueParser.parseQueueRow shape:
 * - subject comes from `Outreach Subject` column (with rich_text → HTML on body)
 * - recipient may come from `Reply Email` column OR `Payload.to_email` / `to`
 * - Cc from Interaction LOG `cc` column (comma-separated) and/or Payload.cc
 * - sender comes from `FCAccount`
 *
 * Strictly read-only against Notion.
 */

import { loadConfig } from "../config/index.js";
import { getPage } from "../notion/client.js";
import { resolveDtcOutboundSend, type DtcSendBundle } from "../notion/dtc-send.js";
import {
  buildPropertyResolver,
  mergeEmailLists,
  normalizeEmail,
  parseEmailListFromText,
  readCommaSeparatedEmails,
  readEmail,
  readRichText,
  readSelectOrStatus,
  richTextPropertyToHtml,
} from "../notion/property-mapper.js";
import type { AppConfig } from "../config/index.js";
import type { OutboundDraft } from "../graph/mail.service.js";

/** Read Outreach Body (or fallbacks) for Send Email / Reply Email → PG `outbound_messages.body`. */
export function resolveOutboundBodyHtml(
  properties: Record<string, unknown>,
  actionType: BuiltSendJob["actionType"],
  cfg: AppConfig,
  payload?: Record<string, unknown> | null,
): string {
  const { pick } = buildPropertyResolver(cfg);
  const bodyProp = pick(properties, "body") as { type?: string } | undefined;
  let bodyHtml = "";
  if (bodyProp?.type === "rich_text") {
    bodyHtml = richTextPropertyToHtml(bodyProp);
  } else if (bodyProp) {
    const plain = readRichText(bodyProp as never).trim();
    if (plain) bodyHtml = plain.includes("<") ? plain : plain.replace(/\n/g, "<br>");
  }

  if (!bodyHtml.trim() && actionType === "reply") {
    const replyBodyProp = pick(properties, "reply_body") as { type?: string } | undefined;
    if (replyBodyProp?.type === "rich_text") {
      bodyHtml = richTextPropertyToHtml(replyBodyProp);
    } else if (replyBodyProp) {
      const plain = readRichText(replyBodyProp as never).trim();
      if (plain) bodyHtml = plain.includes("<") ? plain : plain.replace(/\n/g, "<br>");
    }
  }

  if (!bodyHtml.trim() && payload) {
    bodyHtml =
      (typeof payload.bodyHtml === "string" && payload.bodyHtml.trim()) ||
      (typeof payload.body === "string" && payload.body.trim()) ||
      "";
  }

  return bodyHtml.trim();
}

function parsePayloadObject(payloadText: string): Record<string, unknown> | null {
  if (!payloadText.trim()) return null;
  try {
    const v = JSON.parse(payloadText) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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

  const payloadText = readRichText(pick(page.properties, "payload"));
  const payload = parsePayloadObject(payloadText);

  const actionName = readSelectOrStatus(pick(page.properties, "Action"));
  const actionType: BuiltSendJob["actionType"] =
    actionName === cfg.notion.action_values.send
      ? "send"
      : actionName === cfg.notion.action_values.reply
        ? "reply"
        : "unknown";

  const bodyHtml = resolveOutboundBodyHtml(page.properties as Record<string, unknown>, actionType, cfg, payload);

  // Recipients: payload JSON > Reply Email column.
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

  const ccFromNotion = readCommaSeparatedEmails(pick(page.properties, "cc"));
  const ccFromPayload = (() => {
    if (!payload) return [] as string[];
    if (Array.isArray(payload.cc)) {
      return payload.cc
        .map((v: unknown) => normalizeEmail(String(v)))
        .filter((e: string) => /@/.test(e));
    }
    if (typeof payload.cc === "string") return parseEmailListFromText(payload.cc);
    return [];
  })();
  const ccs = mergeEmailLists(ccFromNotion, ccFromPayload);

  const bccs = Array.isArray(payload?.bcc)
    ? payload.bcc.map((v: unknown) => normalizeEmail(String(v))).filter((e: string) => /@/.test(e))
    : typeof payload?.bcc === "string"
      ? parseEmailListFromText(payload.bcc)
      : [];

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
