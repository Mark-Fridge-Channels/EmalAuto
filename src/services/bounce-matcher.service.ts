/**
 * Match external NDR / bounce messages to outbound rows by failed recipient email.
 *
 * Gmail / Amazon / third-party postmaster bounces usually have a new `conversationId`
 * and `from` = mailer-daemon, so conversation + legacy reply heuristics miss.
 */

import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { outboundMessages, type OutboundMessage } from "../db/schema/outbound_messages.js";
import { logger } from "../utils/logger.js";
import { detectBounce } from "./bounce-detector.service.js";
import { normalizeEmail } from "./legacy-outbound-match.service.js";
import type { InboundMatchInput, MatchResult } from "./reply-matcher.service.js";

type RecipientsJson = { to?: string[]; cc?: string[]; bcc?: string[] };

/** Ordered patterns — first hits win when scanning body + subject. */
const BOUNCE_RECIPIENT_PATTERNS: RegExp[] = [
  /wasn['']t delivered to\s+<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /couldn't be delivered(?:\s+to)?\s*:?\s*<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /could not be delivered\s+to\s+<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /message you sent to\s+<?([^\s<>,;]+@[^\s<>,;]+)>?\s+couldn't/gi,
  /sent to\s+<?([^\s<>,;]+@[^\s<>,;]+)>?\s+couldn't/gi,
  /delivery has failed[^:]*:\s*<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /failed to these recipients[^:]*:\s*<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /bounced address[^:]*:\s*<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /could not resolve address\s+<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
  /tried to reach\s+<?([^\s<>,;]+@[^\s<>,;]+)>?/gi,
];

const GENERIC_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const IGNORE_LOCAL_PART =
  /^(mailer-daemon|postmaster|noreply|no-reply|donotreply|mail-daemon|root|admin)$/i;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function bounceMatchMaxAgeMs(): number {
  const maxDays = Math.max(0, envInt("BOUNCE_MATCH_MAX_DAYS", envInt("LEGACY_MATCH_MAX_DAYS", 30)));
  return maxDays > 0 ? maxDays * 86_400_000 : 0;
}

function shouldIgnoreEmail(email: string, mailboxEmail?: string): boolean {
  const e = normalizeEmail(email);
  if (!e) return true;
  const [local, domain] = e.split("@");
  if (!local || !domain) return true;
  if (IGNORE_LOCAL_PART.test(local)) return true;
  if (domain.includes("mailer-daemon") || domain.includes("googlemail.com") && local === "mailer-daemon") {
    return true;
  }
  const mb = normalizeEmail(mailboxEmail ?? "");
  if (mb && e === mb) return true;
  return false;
}

function collectFromPatterns(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of BOUNCE_RECIPIENT_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const email = normalizeEmail(m[1] ?? "");
      if (email && !seen.has(email)) {
        seen.add(email);
        out.push(email);
      }
    }
  }
  return out;
}

function collectFromGenericScan(text: string, mailboxEmail?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  GENERIC_EMAIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GENERIC_EMAIL_RE.exec(text)) !== null) {
    const email = normalizeEmail(m[0] ?? "");
    if (!email || seen.has(email) || shouldIgnoreEmail(email, mailboxEmail)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Extract likely failed recipient addresses from bounce subject + body preview. */
export function extractFailedRecipientEmails(
  input: { subject: string; bodyPreview: string },
  mailboxEmail?: string,
): string[] {
  const text = `${input.subject ?? ""}\n${input.bodyPreview ?? ""}`;
  const fromPatterns = collectFromPatterns(text).filter((e) => !shouldIgnoreEmail(e, mailboxEmail));
  if (fromPatterns.length > 0) return fromPatterns;
  return collectFromGenericScan(text, mailboxEmail);
}

function outboundRecipientEmails(json: unknown): string[] {
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

function outboundIncludesRecipient(ob: OutboundMessage, email: string): boolean {
  return outboundRecipientEmails(ob.recipientsJson).includes(email);
}

export async function listOutboundSentInWindow(
  mailboxId: number,
  sentAfter: Date,
  sentBefore: Date,
): Promise<OutboundMessage[]> {
  return db
    .select()
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.mailboxId, mailboxId),
        gt(outboundMessages.sentAt, sentAfter),
        lt(outboundMessages.sentAt, sentBefore),
      ),
    )
    .orderBy(desc(outboundMessages.sentAt));
}

function pickUniqueNewest(hits: OutboundMessage[]): OutboundMessage | "ambiguous" | null {
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const bestSent = hits[0]!.sentAt.getTime();
  const tied = hits.filter((h) => h.sentAt.getTime() === bestSent);
  if (tied.length === 1) return tied[0]!;
  return "ambiguous";
}

/**
 * Match a bounce inbox row to the outbound that targeted the failed recipient.
 */
export async function findBounceOutboundMatch(
  inbox: InboundMatchInput & { bodyPreview: string },
  mailboxEmail: string,
): Promise<MatchResult> {
  const bounce = detectBounce({ fromEmail: inbox.fromEmail, subject: inbox.subject });
  if (!bounce.isBounce) {
    return { matched: false, reason: "not a bounce" };
  }

  const failedEmails = extractFailedRecipientEmails(
    { subject: inbox.subject, bodyPreview: inbox.bodyPreview },
    mailboxEmail,
  );
  if (failedEmails.length === 0) {
    return { matched: false, reason: "bounce: no failed recipient email in body/subject" };
  }

  const receivedMs = inbox.receivedAt.getTime();
  const maxAgeMs = bounceMatchMaxAgeMs();
  const sentAfter =
    maxAgeMs > 0 ? new Date(receivedMs - maxAgeMs) : new Date(0);
  const sentBefore = new Date(receivedMs);

  const rows = await listOutboundSentInWindow(inbox.mailboxId, sentAfter, sentBefore);
  if (rows.length === 0) {
    return { matched: false, reason: "bounce: no outbound in time window" };
  }

  for (const failedEmail of failedEmails) {
    const hits = rows.filter((o) => outboundIncludesRecipient(o, failedEmail));
    const picked = pickUniqueNewest(hits);
    if (picked === "ambiguous") {
      logger.warn(
        { mailboxId: inbox.mailboxId, failedEmail, subject: inbox.subject },
        "bounce recipient match: ambiguous outbound candidates",
      );
      continue;
    }
    if (picked) {
      logger.info(
        {
          mailboxId: inbox.mailboxId,
          outboundId: picked.id,
          failedEmail,
          notionPageId: picked.notionPageId,
        },
        "bounce recipient match: inbound matched outbound",
      );
      return {
        matched: true,
        outboundId: picked.id,
        notionPageId: picked.notionPageId,
        method: "bounce_recipient",
      };
    }
  }

  return {
    matched: false,
    reason: `bounce: no outbound to ${failedEmails.join(", ")} in time window`,
  };
}
