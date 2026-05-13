/**
 * Match an inbound message to an outbound conversation by `conversationId`.
 *
 * Why conversationId only (per PRD §5):
 * - CC reply / same-domain reply / forwarded-then-replied all share the same
 *   conversationId in Exchange Online.
 * - `from == recipient` is unsafe (forwarders and aliases break it).
 *
 * Cross-tenant note: if the reply originates from a tenant with a different
 * conversation index, conversationId may NOT match. V1 only logs that gap;
 * `In-Reply-To` / `References` header fallback is parked for V1.5.
 */

import { logger } from "../utils/logger.js";
import { findOutboundByConversation, markOutboundReplyReceived } from "./message-store.service.js";

export interface MatchResult {
  matched: boolean;
  outboundId?: number;
  notionPageId?: string;
  reason?: string;
}

export async function matchInboundByConversation(
  conversationId: string,
): Promise<MatchResult> {
  if (!conversationId) {
    return { matched: false, reason: "no conversationId on inbound" };
  }
  const candidates = await findOutboundByConversation(conversationId);
  if (candidates.length === 0) {
    return { matched: false, reason: "no outbound with this conversationId" };
  }
  // Multiple outbound under same conversation = thread. Use the newest one
  // as anchor — it's the most recent message we sent in that thread.
  candidates.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const hit = candidates[0]!;
  await markOutboundReplyReceived(hit.id);
  logger.info(
    {
      conversationId,
      outboundId: hit.id,
      notionPageId: hit.notionPageId,
      candidates: candidates.length,
    },
    "reply matched",
  );
  return { matched: true, outboundId: hit.id, notionPageId: hit.notionPageId };
}
