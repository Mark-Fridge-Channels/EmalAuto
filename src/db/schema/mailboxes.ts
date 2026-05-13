/**
 * Mailbox registry.
 *
 * App-only auth means we do NOT store per-mailbox tokens.
 * This table is just the operational state (enabled flags, sync cursors).
 */

import { pgTable, serial, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: serial("id").primaryKey(),
    /** UPN / primary SMTP, used as `users/{email}` in Graph URIs. */
    email: text("email").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    canSend: boolean("can_send").notNull().default(true),
    canReceive: boolean("can_receive").notNull().default(true),
    /** Per-folder last-sync cursors (UTC). NULL = never synced. */
    inboxLastSyncAt: timestamp("inbox_last_sync_at", { withTimezone: true }),
    junkLastSyncAt: timestamp("junk_last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUniq: uniqueIndex("mailboxes_email_uniq").on(t.email),
  }),
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;
