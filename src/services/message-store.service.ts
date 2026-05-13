/**
 * outbound_messages persistence.
 *
 * Insert one row per successful sendMail. The row's `conversation_id` becomes
 * the lookup key for inbound matching.
 */

import { db } from "../db/client.js";
import { outboundMessages, type NewOutboundMessage, type OutboundMessage } from "../db/schema/outbound_messages.js";
import { eq } from "drizzle-orm";

export async function recordOutbound(row: NewOutboundMessage): Promise<OutboundMessage> {
  const [inserted] = await db.insert(outboundMessages).values(row).returning();
  return inserted!;
}

export async function findOutboundByConversation(conversationId: string): Promise<OutboundMessage[]> {
  return db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.conversationId, conversationId));
}

export async function findOutboundByPage(notionPageId: string): Promise<OutboundMessage[]> {
  return db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.notionPageId, notionPageId));
}

export async function markOutboundBounce(
  id: number,
  reason: string,
): Promise<void> {
  await db
    .update(outboundMessages)
    .set({ threadStatus: "bounce", bounceReason: reason, updatedAt: new Date() })
    .where(eq(outboundMessages.id, id));
}

export async function markOutboundReplyReceived(id: number): Promise<void> {
  await db
    .update(outboundMessages)
    .set({ threadStatus: "reply_received", updatedAt: new Date() })
    .where(eq(outboundMessages.id, id));
}
