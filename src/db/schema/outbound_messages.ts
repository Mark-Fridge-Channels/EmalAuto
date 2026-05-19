/**
 * Every successfully sent Graph message — the anchor for Reply Matching.
 *
 * Indexed on `conversation_id` because that is the lookup key used by
 * inbound matching. Also indexed on `notion_page_id` to walk back to source.
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

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: serial("id").primaryKey(),
    mailboxId: integer("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    /** Null when the send was recorded without a Notion task (e.g. admin reply with no anchor). */
    notionPageId: text("notion_page_id"),
    /** Graph `message.id` (per-mailbox unique). */
    graphMessageId: text("graph_message_id").notNull(),
    /** RFC Message-ID, e.g. `<...@host>`. */
    internetMessageId: text("internet_message_id"),
    /** The single most-important field in the system. */
    conversationId: text("conversation_id").notNull(),
    subject: text("subject").notNull().default(""),
    /** HTML or plain body copied from Notion Outreach Body / send draft (may be empty on legacy rows). */
    body: text("body").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** { to: string[], cc: string[], bcc: string[] } */
    recipientsJson: jsonb("recipients_json").notNull().default({}),
    /** Free-form bag for downstream debug (kept tiny). */
    metaJson: jsonb("meta_json").notNull().default({}),
    /** sent | reply_received | bounce | failed (mirrors PRD state machine). */
    threadStatus: text("thread_status").notNull().default("sent"),
    bounceReason: text("bounce_reason"),
    keyPersonId: text("key_person_id"),
    keyPersonName: text("key_person_name"),
    keyPersonNotionUrl: text("key_person_notion_url"),
    entityName: text("entity_name"),
    entityNotionUrl: text("entity_notion_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    convIdx: index("outbound_conversation_idx").on(t.conversationId),
    mailboxSentIdx: index("outbound_mailbox_sent_idx").on(t.mailboxId, t.sentAt),
    pageIdx: index("outbound_notion_page_idx").on(t.notionPageId),
    graphMsgUniq: uniqueIndex("outbound_graph_msg_uniq").on(t.mailboxId, t.graphMessageId),
    entityIdx: index("outbound_entity_name_idx").on(t.entityName),
    keyPersonIdx: index("outbound_key_person_id_idx").on(t.keyPersonId),
  }),
);

export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type NewOutboundMessage = typeof outboundMessages.$inferInsert;
