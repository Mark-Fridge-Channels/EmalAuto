/**
 * Read/write helpers for `inbox_messages`.
 */

import { and, eq, sql, desc, asc, gte, lte, ilike, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { inboxMessages, type InboxMessage, type NewInboxMessage } from "../schema/inbox_messages.js";
import { mailboxes } from "../schema/mailboxes.js";

export async function insertInboxIfNew(row: NewInboxMessage): Promise<InboxMessage | null> {
  // Unique index on (mailboxId, graphMessageId) gives us idempotency.
  try {
    const [inserted] = await db.insert(inboxMessages).values(row).returning();
    return inserted ?? null;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") return null;
    throw err;
  }
}

export async function findInboxById(id: number): Promise<InboxMessage | undefined> {
  const rows = await db.select().from(inboxMessages).where(eq(inboxMessages.id, id));
  return rows[0];
}

export async function markInboxMatched(
  id: number,
  outboundId: number,
  status: "matched" | "bounce" | "auto_reply",
): Promise<void> {
  await db
    .update(inboxMessages)
    .set({ matchStatus: status, matchedOutboundId: outboundId })
    .where(eq(inboxMessages.id, id));
}

export async function markInboxIgnored(id: number): Promise<void> {
  await db
    .update(inboxMessages)
    .set({ matchStatus: "ignored" })
    .where(eq(inboxMessages.id, id));
}

export async function findInboxByGraphId(
  mailboxId: number,
  graphMessageId: string,
): Promise<InboxMessage | undefined> {
  const rows = await db
    .select()
    .from(inboxMessages)
    .where(and(eq(inboxMessages.mailboxId, mailboxId), eq(inboxMessages.graphMessageId, graphMessageId)));
  return rows[0];
}

export type InboxAdminMatchStatusFilter =
  | "matched"
  | "unmatched"
  | "ignored"
  | "bounce"
  | "auto_reply"
  | "all";

export interface InboxAdminListParams {
  entityName?: string;
  keyPersonId?: string;
  email?: string;
  domain?: string;
  receivedFrom?: Date;
  receivedTo?: Date;
  /** Default in API: `matched`. Use `all` to list every `match_status`. */
  matchStatus?: InboxAdminMatchStatusFilter;
  limit: number;
  offset: number;
  order: "received_desc" | "received_asc";
}

export async function listInboxForAdmin(params: InboxAdminListParams): Promise<{ rows: InboxRowWithMailbox[]; total: number }> {
  const conditions: SQL[] = [];
  if (params.entityName?.trim()) {
    conditions.push(ilike(inboxMessages.entityName, `%${params.entityName.trim()}%`));
  }
  if (params.keyPersonId?.trim()) {
    conditions.push(eq(inboxMessages.keyPersonId, params.keyPersonId.trim()));
  }
  if (params.email?.trim()) {
    conditions.push(ilike(inboxMessages.fromEmail, `%${params.email.trim().toLowerCase()}%`));
  }
  if (params.domain?.trim()) {
    conditions.push(ilike(mailboxes.email, `%@${params.domain.trim().toLowerCase()}`));
  }
  if (params.receivedFrom) {
    conditions.push(gte(inboxMessages.receivedAt, params.receivedFrom));
  }
  if (params.receivedTo) {
    conditions.push(lte(inboxMessages.receivedAt, params.receivedTo));
  }
  if (params.matchStatus && params.matchStatus !== "all") {
    conditions.push(eq(inboxMessages.matchStatus, params.matchStatus));
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const orderBy =
    params.order === "received_asc" ? asc(inboxMessages.receivedAt) : desc(inboxMessages.receivedAt);

  const base = db
    .select({ inbox: inboxMessages, fcEmail: mailboxes.email })
    .from(inboxMessages)
    .innerJoin(mailboxes, eq(inboxMessages.mailboxId, mailboxes.id))
    .where(whereClause);

  const countQ = db
    .select({ c: sql<number>`count(*)::int` })
    .from(inboxMessages)
    .innerJoin(mailboxes, eq(inboxMessages.mailboxId, mailboxes.id))
    .where(whereClause);
  const countRows = await countQ;
  const total = countRows[0]?.c ?? 0;

  const rows = await base.orderBy(orderBy).limit(params.limit).offset(params.offset);
  return {
    rows: rows.map((r) => ({ ...r.inbox, fcAccount: r.fcEmail })),
    total: total ?? 0,
  };
}

export type InboxRowWithMailbox = InboxMessage & { fcAccount: string };

export async function updateInboxCrmFields(
  id: number,
  patch: Partial<{
    keyPersonId: string | null;
    keyPersonName: string | null;
    keyPersonNotionUrl: string | null;
    entityName: string | null;
    entityNotionUrl: string | null;
  }>,
): Promise<void> {
  await db.update(inboxMessages).set(patch).where(eq(inboxMessages.id, id));
}
