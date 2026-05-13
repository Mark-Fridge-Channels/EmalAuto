/**
 * Persist Graph subscription id + delta cursor per mailbox + folder.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { webhookSubscriptions, type WebhookSubscription } from "../schema/webhook_subscriptions.js";

export async function findWebhookRow(
  mailboxId: number,
  folder: string,
): Promise<WebhookSubscription | undefined> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.mailboxId, mailboxId), eq(webhookSubscriptions.folder, folder)));
  return rows[0];
}

export async function upsertWebhookRow(input: {
  mailboxId: number;
  folder: string;
  subscriptionId: string;
  expiresAt: Date;
  deltaLink?: string | null;
}): Promise<WebhookSubscription> {
  const existing = await findWebhookRow(input.mailboxId, input.folder);
  if (existing) {
    const [u] = await db
      .update(webhookSubscriptions)
      .set({
        subscriptionId: input.subscriptionId,
        expiresAt: input.expiresAt,
        deltaLink: input.deltaLink ?? existing.deltaLink,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(webhookSubscriptions.id, existing.id))
      .returning();
    return u!;
  }
  const [ins] = await db
    .insert(webhookSubscriptions)
    .values({
      mailboxId: input.mailboxId,
      folder: input.folder,
      subscriptionId: input.subscriptionId,
      expiresAt: input.expiresAt,
      deltaLink: input.deltaLink ?? null,
      status: "active",
    })
    .returning();
  return ins!;
}

export async function updateDeltaLink(
  mailboxId: number,
  folder: string,
  deltaLink: string | null,
): Promise<void> {
  const row = await findWebhookRow(mailboxId, folder);
  if (!row) return;
  await db
    .update(webhookSubscriptions)
    .set({ deltaLink, updatedAt: new Date() })
    .where(eq(webhookSubscriptions.id, row.id));
}

export async function listWebhookRows(): Promise<WebhookSubscription[]> {
  return db.select().from(webhookSubscriptions);
}
