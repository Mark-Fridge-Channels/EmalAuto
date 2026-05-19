/**
 * outbound_messages persistence.
 *
 * Insert one row per successful sendMail. The row's `conversation_id` becomes
 * the lookup key for inbound matching.
 */

import { db } from "../db/client.js";
import { outboundMessages, type NewOutboundMessage, type OutboundMessage } from "../db/schema/outbound_messages.js";
import { and, desc, eq } from "drizzle-orm";

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

export async function findOutboundById(id: number): Promise<OutboundMessage | undefined> {
  const rows = await db.select().from(outboundMessages).where(eq(outboundMessages.id, id)).limit(1);
  return rows[0];
}

/** Newest outbound in the same Graph conversation + mailbox (for inbox ingest CRM prefill). */
export async function findNewestOutboundByConversation(
  conversationId: string,
  mailboxId: number,
): Promise<OutboundMessage | undefined> {
  if (!conversationId.trim()) return undefined;
  const rows = await db
    .select()
    .from(outboundMessages)
    .where(
      and(eq(outboundMessages.conversationId, conversationId), eq(outboundMessages.mailboxId, mailboxId)),
    )
    .orderBy(desc(outboundMessages.sentAt))
    .limit(1);
  return rows[0];
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
