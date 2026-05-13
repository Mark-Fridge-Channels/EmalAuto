/**
 * Read/write helpers for `inbox_messages`.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { inboxMessages, type InboxMessage, type NewInboxMessage } from "../schema/inbox_messages.js";

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
  status: "matched" | "bounce",
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
