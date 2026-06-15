/**
 * Emails that opted out via RFC 8058 one-click List-Unsubscribe.
 */

import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    notionPageId: text("notion_page_id"),
    source: text("source").notNull().default("list_unsubscribe_one_click"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUniq: uniqueIndex("email_suppressions_email_uniq").on(t.email),
  }),
);

export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type NewEmailSuppression = typeof emailSuppressions.$inferInsert;
