/**
 * Graph webhook subscriptions (V2 only — table created up front so V1→V2
 * is purely additive code, not schema migration).
 */

import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { mailboxes } from "./mailboxes.js";

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: serial("id").primaryKey(),
    mailboxId: integer("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    /** Well-known folder id, e.g. `inbox`, `junkemail` (matches Graph mailFolders segment). */
    folder: text("folder").notNull().default("inbox"),
    subscriptionId: text("subscription_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** @odata.deltaLink from the last successful delta sync for this mailbox+folder. */
    deltaLink: text("delta_link"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subUniq: uniqueIndex("webhook_sub_uniq").on(t.subscriptionId),
    /** One active subscription + delta cursor row per mailbox per folder. */
    mailboxFolderUniq: uniqueIndex("webhook_mailbox_folder_uniq").on(t.mailboxId, t.folder),
  }),
);

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
