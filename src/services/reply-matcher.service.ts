/**
 * Match an inbound message to an outbound conversation by `conversationId`.
 *
 * Why conversationId first (per PRD §5):
 * - CC reply / same-domain reply / forwarded-then-replied all share the same
 *   conversationId in Exchange Online.
 * - `from == recipient` is unsafe (forwarders and aliases break it).
 *
 * Legacy backfill rows (`notion-legacy-conv:*`) cannot use Graph conversationId;
 * `resolveInboundOutboundMatch` falls back to subject/recipient/time heuristics.
 *
 * Cross-tenant note: if the reply originates from a tenant with a different
 * conversation index, conversationId may NOT match. V1 only logs that gap;
 * `In-Reply-To` / `References` header fallback is parked for V1.5.
 */

import { logger } from "../utils/logger.js";
import { detectBounce } from "./bounce-detector.service.js";
import { findBounceOutboundMatch } from "./bounce-matcher.service.js";
import { findOutboundByConversation } from "./message-store.service.js";
import {
  isLegacyOutboundConversationId,
  legacyMatchOptionsFromEnv,
  listLegacyOutboundForMailbox,
  resolveLegacyOutboundMatch,
} from "./legacy-outbound-match.service.js";

export interface MatchResult {
  matched: boolean;
  outboundId?: number;
  /** Present when the newest outbound row in the thread has a Notion task id. */
  notionPageId?: string | null;
  reason?: string;
  /** How the outbound row was resolved (for logs / metrics). */
  method?: "conversation" | "legacy_heuristic" | "bounce_recipient";
}

export interface InboundMatchInput {
  mailboxId: number;
  conversationId: string;
  subject: string;
  fromEmail: string;
  recipientsJson: unknown;
  receivedAt: Date;
  bodyPreview?: string;
}

/** Lookup only — does not mutate `thread_status`. */
export async function findOutboundMatchByConversation(conversationId: string): Promise<MatchResult> {
  if (!conversationId) {
    return { matched: false, reason: "no conversationId on inbound" };
  }
  const candidates = await findOutboundByConversation(conversationId);
  const graphCandidates = candidates.filter((c) => !isLegacyOutboundConversationId(c.conversationId));
  if (graphCandidates.length === 0) {
    return { matched: false, reason: "no outbound with this conversationId" };
  }
  graphCandidates.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const hit = graphCandidates[0]!;
  return {
    matched: true,
    outboundId: hit.id,
    notionPageId: hit.notionPageId,
    method: "conversation",
  };
}

/** Heuristic match against legacy backfill rows for one mailbox. */
export async function findLegacyOutboundMatch(
  inbox: InboundMatchInput,
  mailboxEmail: string,
): Promise<MatchResult> {
  const legacyRows = await listLegacyOutboundForMailbox(inbox.mailboxId);
  if (legacyRows.length === 0) {
    return { matched: false, reason: "no legacy outbound rows for mailbox" };
  }

  const resolved = resolveLegacyOutboundMatch(inbox, legacyRows, mailboxEmail, legacyMatchOptionsFromEnv());
  if (resolved.kind === "none") {
    return { matched: false, reason: "legacy heuristic: no candidate" };
  }
  if (resolved.kind === "ambiguous") {
    logger.warn(
      { mailboxId: inbox.mailboxId, subject: inbox.subject, from: inbox.fromEmail },
      "legacy heuristic: ambiguous outbound candidates",
    );
    return { matched: false, reason: "legacy heuristic: ambiguous" };
  }

  const hit = resolved.hit;
  logger.info(
    {
      mailboxId: inbox.mailboxId,
      outboundId: hit.id,
      notionPageId: hit.notionPageId,
      subject: inbox.subject,
    },
    "legacy heuristic: inbound matched outbound",
  );
  return {
    matched: true,
    outboundId: hit.id,
    notionPageId: hit.notionPageId,
    method: "legacy_heuristic",
  };
}

/**
 * Resolve outbound for an inbound row: conversationId → bounce recipient → legacy heuristic.
 * Does not update `thread_status` — the match worker applies status after bounce detection.
 */
export async function resolveInboundOutboundMatch(
  inbox: InboundMatchInput,
  mailboxEmail: string,
): Promise<MatchResult> {
  const byConv = await findOutboundMatchByConversation(inbox.conversationId);
  if (byConv.matched) return byConv;

  const bounce = detectBounce({
    fromEmail: inbox.fromEmail,
    subject: inbox.subject,
    bodyPreview: inbox.bodyPreview ?? "",
  });
  if (bounce.isBounce) {
    const byRecipient = await findBounceOutboundMatch(
      { ...inbox, bodyPreview: inbox.bodyPreview ?? "" },
      mailboxEmail,
    );
    if (byRecipient.matched) return byRecipient;
  }

  return findLegacyOutboundMatch(inbox, mailboxEmail);
}

/**
 * @deprecated Prefer `resolveInboundOutboundMatch` + explicit status updates in the worker.
 */
export async function matchInboundByConversation(conversationId: string): Promise<MatchResult> {
  return findOutboundMatchByConversation(conversationId);
}
