/**
 * Cache of inbound Graph messages we have observed.
 *
 * Used as the source of truth for Reply Matching and Bounce Detection,
 * so we never re-process the same Graph message twice.
 */

import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { mailboxes } from "./mailboxes.js";

export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: serial("id").primaryKey(),
    mailboxId: integer("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    /** "inbox" | "junkemail" | other well-known folder names. */
    folder: text("folder").notNull(),
    graphMessageId: text("graph_message_id").notNull(),
    internetMessageId: text("internet_message_id"),
    conversationId: text("conversation_id").notNull(),
    fromEmail: text("from_email").notNull().default(""),
    /** Recipient JSON: { to: [...], cc: [...] } */
    recipientsJson: jsonb("recipients_json").notNull().default({}),
    subject: text("subject").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    bodyPreview: text("body_preview").notNull().default(""),
    /** The slim Graph message JSON we actually fetched. */
    rawJson: jsonb("raw_json").notNull().default({}),
    /** matched | bounce | ignored | unmatched */
    matchStatus: text("match_status").notNull().default("unmatched"),
    matchedOutboundId: integer("matched_outbound_id"),
    /** Optional CRM fields copied from parent Notion outbound when matched. */
    keyPersonId: text("key_person_id"),
    keyPersonName: text("key_person_name"),
    keyPersonNotionUrl: text("key_person_notion_url"),
    entityName: text("entity_name"),
    entityNotionUrl: text("entity_notion_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    msgUniq: uniqueIndex("inbox_msg_uniq").on(t.mailboxId, t.graphMessageId),
    convIdx: index("inbox_conversation_idx").on(t.conversationId),
    mailboxRecvIdx: index("inbox_mailbox_recv_idx").on(t.mailboxId, t.receivedAt),
    entityIdx: index("inbox_entity_name_idx").on(t.entityName),
    keyPersonIdx: index("inbox_key_person_id_idx").on(t.keyPersonId),
  }),
);

export type InboxMessage = typeof inboxMessages.$inferSelect;
export type NewInboxMessage = typeof inboxMessages.$inferInsert;
