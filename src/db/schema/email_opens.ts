/**
 * Outbound email open events (1×1 tracking pixel hits).
 */

import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const emailOpens = pgTable(
  "email_opens",
  {
    id: serial("id").primaryKey(),
    /** Normalized recipient from the signed open token. */
    email: text("email").notNull(),
    notionPageId: text("notion_page_id"),
    /** Optional link to outbound_messages when resolved at hit time. */
    outboundId: integer("outbound_id"),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index("email_opens_email_idx").on(t.email),
    notionIdx: index("email_opens_notion_idx").on(t.notionPageId),
    outboundIdx: index("email_opens_outbound_idx").on(t.outboundId),
    createdIdx: index("email_opens_created_idx").on(t.createdAt),
  }),
);

export type EmailOpen = typeof emailOpens.$inferSelect;
export type NewEmailOpen = typeof emailOpens.$inferInsert;
