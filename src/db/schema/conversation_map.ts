/**
 * conversationId → notion_page_id map.
 *
 * Optimized lookup: given a brand-new inbound `conversationId`, find the
 * Notion page that originally triggered the thread without scanning
 * outbound_messages every time.
 */

import { pgTable, serial, text, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

export const conversationMap = pgTable(
  "conversation_map",
  {
    id: serial("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    notionPageId: text("notion_page_id").notNull(),
    /** Latest inbound row we've matched into this conversation. */
    latestInboxId: integer("latest_inbox_id"),
    latestInboundAt: timestamp("latest_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    convUniq: uniqueIndex("conv_map_conv_uniq").on(t.conversationId),
    pageIdx: index("conv_map_page_idx").on(t.notionPageId),
  }),
);

export type ConversationMapRow = typeof conversationMap.$inferSelect;
export type NewConversationMapRow = typeof conversationMap.$inferInsert;
