import { and, eq, sql, desc, asc, gte, lte, ilike, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { outboundMessages, type OutboundMessage } from "../schema/outbound_messages.js";
import { mailboxes } from "../schema/mailboxes.js";

export interface OutboundAdminListParams {
  entityName?: string;
  keyPersonId?: string;
  notionPageId?: string;
  domain?: string;
  sentFrom?: Date;
  sentTo?: Date;
  limit: number;
  offset: number;
  order: "sent_desc" | "sent_asc";
}

export type OutboundRowWithMailbox = OutboundMessage & { fcAccount: string };

export async function listOutboundForAdmin(
  params: OutboundAdminListParams,
): Promise<{ rows: OutboundRowWithMailbox[]; total: number }> {
  const conditions: SQL[] = [];
  if (params.entityName?.trim()) {
    conditions.push(ilike(outboundMessages.entityName, `%${params.entityName.trim()}%`));
  }
  if (params.keyPersonId?.trim()) {
    conditions.push(eq(outboundMessages.keyPersonId, params.keyPersonId.trim()));
  }
  if (params.notionPageId?.trim()) {
    conditions.push(eq(outboundMessages.notionPageId, params.notionPageId.trim()));
  }
  if (params.domain?.trim()) {
    conditions.push(ilike(mailboxes.email, `%@${params.domain.trim().toLowerCase()}`));
  }
  if (params.sentFrom) conditions.push(gte(outboundMessages.sentAt, params.sentFrom));
  if (params.sentTo) conditions.push(lte(outboundMessages.sentAt, params.sentTo));

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const orderBy =
    params.order === "sent_asc" ? asc(outboundMessages.sentAt) : desc(outboundMessages.sentAt);

  const countQ = db
    .select({ c: sql<number>`count(*)::int` })
    .from(outboundMessages)
    .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
    .where(whereClause);
  const countRows = await countQ;
  const total = countRows[0]?.c ?? 0;

  const rows = await db
    .select({ ob: outboundMessages, fcEmail: mailboxes.email })
    .from(outboundMessages)
    .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(params.limit)
    .offset(params.offset);

  return {
    rows: rows.map((r) => ({ ...r.ob, fcAccount: r.fcEmail })),
    total,
  };
}

export async function updateOutboundCrmFields(
  id: number,
  patch: Partial<{
    keyPersonId: string | null;
    keyPersonName: string | null;
    keyPersonNotionUrl: string | null;
    entityName: string | null;
    entityNotionUrl: string | null;
  }>,
): Promise<void> {
  await db.update(outboundMessages).set({ ...patch, updatedAt: new Date() }).where(eq(outboundMessages.id, id));
}
