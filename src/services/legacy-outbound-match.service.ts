/**
 * Heuristic matching for outbound rows backfilled without a real Graph `conversationId`
 * (`notion-legacy-conv:*` placeholders). Used only when conversationId lookup misses.
 *
 * New sends that go through Graph still use `reply-matcher` conversation matching first.
 */

import { and, eq, like } from "drizzle-orm";
import { db } from "../db/client.js";
import { outboundMessages } from "../db/schema/outbound_messages.js";

export const LEGACY_MSG_PREFIX = "notion-legacy:";
export const LEGACY_CONV_PREFIX = "notion-legacy-conv:";

export function isLegacyOutboundConversationId(conversationId: string): boolean {
  const c = String(conversationId ?? "");
  return c.startsWith(LEGACY_CONV_PREFIX) || c.startsWith(LEGACY_MSG_PREFIX);
}

type RecipientsJson = { to?: string[]; cc?: string[]; bcc?: string[] };

export type LegacyOutboundCandidate = {
  id: number;
  mailboxId: number;
  subject: string;
  sentAt: Date;
  recipientsJson: unknown;
  notionPageId: string | null;
};

export type LegacyMatchResolve =
  | { kind: "unique"; hit: LegacyOutboundCandidate }
  | { kind: "none" }
  | { kind: "ambiguous" };

export interface LegacyMatchOptions {
  relaxedSubject: boolean;
  /** 0 = no limit */
  maxAgeMs: number;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

export function legacyMatchOptionsFromEnv(): LegacyMatchOptions {
  const maxDays = Math.max(0, envInt("LEGACY_MATCH_MAX_DAYS", 365));
  return {
    relaxedSubject: envBool("LEGACY_MATCH_RELAXED_SUBJECT", false),
    maxAgeMs: maxDays > 0 ? maxDays * 86_400_000 : 0,
  };
}

export function normCompare(s: string): string {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeEmail(e: string): string {
  const t = String(e ?? "").trim().toLowerCase();
  return t && t.includes("@") ? t : "";
}

/** Strip Re:/Fwd:/回复 等前缀，便于与历史发信主题对齐。 */
export function normalizeThreadSubject(s: string): string {
  let t = normCompare(s);
  for (let i = 0; i < 6; i++) {
    const next = t
      .replace(/^(re|fwd|fw|aw|回复|答复|轉寄|转发|轉發)[\s:\[\]【】]*\s*/iu, "")
      .trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

function recipientEmails(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const o = json as RecipientsJson;
  const all = [...(o.to ?? []), ...(o.cc ?? []), ...(o.bcc ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const e = normalizeEmail(String(raw));
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

function subjectsMatch(inboxSubject: string, outboundSubject: string, relaxed: boolean): boolean {
  const a = normalizeThreadSubject(inboxSubject);
  const b = normalizeThreadSubject(outboundSubject);
  if (!a || !b) return false;
  if (a === b) return true;
  if (relaxed && (a.includes(b) || b.includes(a))) return true;
  return false;
}

function partyMatches(
  inboxFrom: string,
  inboxRecipients: unknown,
  outboundRecipients: unknown,
  mailboxEmail: string,
): boolean {
  const from = normalizeEmail(inboxFrom);
  if (!from) return false;

  const outboundTo = recipientEmails(outboundRecipients);
  if (outboundTo.length === 0) return false;
  if (!outboundTo.includes(from)) return false;

  const mb = normalizeEmail(mailboxEmail);
  if (!mb) return true;

  const inboxTo = recipientEmails(inboxRecipients);
  if (inboxTo.length === 0) return true;
  return inboxTo.includes(mb);
}

export function resolveLegacyOutboundMatch(
  inbox: {
    mailboxId: number;
    subject: string;
    fromEmail: string;
    recipientsJson: unknown;
    receivedAt: Date;
  },
  outboundList: LegacyOutboundCandidate[],
  mailboxEmail: string,
  options: LegacyMatchOptions,
): LegacyMatchResolve {
  const hits: LegacyOutboundCandidate[] = [];
  const receivedMs = inbox.receivedAt.getTime();

  for (const o of outboundList) {
    if (o.mailboxId !== inbox.mailboxId) continue;
    const sentMs = o.sentAt.getTime();
    if (sentMs >= receivedMs) continue;
    if (options.maxAgeMs > 0 && receivedMs - sentMs > options.maxAgeMs) continue;
    if (!subjectsMatch(inbox.subject, o.subject, options.relaxedSubject)) continue;
    if (!partyMatches(inbox.fromEmail, inbox.recipientsJson, o.recipientsJson, mailboxEmail)) continue;
    hits.push(o);
  }

  if (hits.length === 0) return { kind: "none" };

  hits.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const bestSent = hits[0]!.sentAt.getTime();
  const tied = hits.filter((h) => h.sentAt.getTime() === bestSent);
  if (tied.length === 1) return { kind: "unique", hit: tied[0]! };
  return { kind: "ambiguous" };
}

export async function listLegacyOutboundForMailbox(mailboxId: number): Promise<LegacyOutboundCandidate[]> {
  return db
    .select({
      id: outboundMessages.id,
      mailboxId: outboundMessages.mailboxId,
      subject: outboundMessages.subject,
      sentAt: outboundMessages.sentAt,
      recipientsJson: outboundMessages.recipientsJson,
      notionPageId: outboundMessages.notionPageId,
    })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.mailboxId, mailboxId), like(outboundMessages.conversationId, `${LEGACY_CONV_PREFIX}%`)));
}
