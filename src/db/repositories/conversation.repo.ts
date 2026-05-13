/**
 * conversation_map repo. Single-row-per-conversationId.
 */

import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { conversationMap, type ConversationMapRow } from "../schema/conversation_map.js";

export async function upsertConversation(
  conversationId: string,
  notionPageId: string,
  latestInboxId: number,
  latestInboundAt: Date,
): Promise<ConversationMapRow> {
  const existing = await db
    .select()
    .from(conversationMap)
    .where(eq(conversationMap.conversationId, conversationId));
  if (existing.length > 0) {
    const cur = existing[0]!;
    const [updated] = await db
      .update(conversationMap)
      .set({
        latestInboxId,
        latestInboundAt,
        // notion_page_id is set at creation; we don't overwrite it.
        updatedAt: new Date(),
      })
      .where(eq(conversationMap.id, cur.id))
      .returning();
    return updated!;
  }
  const [inserted] = await db
    .insert(conversationMap)
    .values({ conversationId, notionPageId, latestInboxId, latestInboundAt })
    .returning();
  return inserted!;
}
