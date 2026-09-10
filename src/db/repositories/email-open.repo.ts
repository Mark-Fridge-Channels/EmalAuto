import { desc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { emailOpens } from "../schema/email_opens.js";
import { outboundMessages } from "../schema/outbound_messages.js";

export async function findLatestOutboundIdByNotionPageId(
  notionPageId: string,
): Promise<number | null> {
  const id = notionPageId.trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(eq(outboundMessages.notionPageId, id))
    .orderBy(desc(outboundMessages.sentAt))
    .limit(1);
  return row?.id ?? null;
}

export async function recordEmailOpen(params: {
  email: string;
  notionPageId?: string | null;
  outboundId?: number | null;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<{ id: number }> {
  const email = params.email.trim().toLowerCase();
  const [row] = await db
    .insert(emailOpens)
    .values({
      email,
      notionPageId: params.notionPageId?.trim() || null,
      outboundId: params.outboundId ?? null,
      userAgent: params.userAgent?.trim().slice(0, 512) || null,
      ipHash: params.ipHash?.trim() || null,
    })
    .returning({ id: emailOpens.id });
  return { id: row!.id };
}
