/**
 * Mailbox repository — DB is the source of truth.
 *
 * Mailboxes are managed directly in the `mailboxes` table (e.g. via Supabase
 * Studio). On startup we only audit existing rows against `graph_apps`: any
 * mailbox whose domain has no matching App is logged as a warning, since we
 * can't get a Graph token for it.
 */

import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { mailboxes, type Mailbox } from "../schema/mailboxes.js";
import { loadConfig, resolveAppKeyForMailbox } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

export async function findMailboxByEmail(email: string): Promise<Mailbox | undefined> {
  const rows = await db.select().from(mailboxes).where(eq(mailboxes.email, email));
  return rows[0];
}

export async function listEnabledMailboxes(): Promise<Mailbox[]> {
  return db.select().from(mailboxes).where(eq(mailboxes.enabled, true));
}

export async function listAllMailboxes(): Promise<Mailbox[]> {
  return db.select().from(mailboxes);
}

/**
 * Log a one-shot health summary of the `mailboxes` table at boot:
 *   total / enabled / send / receive / orphans-with-no-matching-App.
 *
 * Pure read; never mutates DB rows. Safe to call from both API and worker.
 */
export async function auditMailboxesAgainstApps(): Promise<void> {
  const cfg = loadConfig();
  const rows = await listAllMailboxes();
  const orphans: string[] = [];
  for (const r of rows) {
    if (!resolveAppKeyForMailbox(r.email, cfg)) orphans.push(r.email);
  }
  logger.info(
    {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      can_send: rows.filter((r) => r.canSend).length,
      can_receive: rows.filter((r) => r.canReceive).length,
      orphans: orphans.length,
    },
    "mailbox audit",
  );
  if (orphans.length > 0) {
    logger.warn(
      { orphans },
      "mailboxes in DB whose domain has no graph_apps entry; they will be skipped at runtime",
    );
  }
}

export async function setFolderCursor(
  mailboxId: number,
  folder: string,
  receivedAt: Date,
): Promise<void> {
  const patch: Partial<Mailbox> = {};
  if (folder === "inbox") patch.inboxLastSyncAt = receivedAt;
  else if (folder === "junkemail") patch.junkLastSyncAt = receivedAt;
  if (Object.keys(patch).length === 0) return;
  await db.update(mailboxes).set(patch).where(eq(mailboxes.id, mailboxId));
}

export function readFolderCursor(box: Mailbox, folder: string): Date | null {
  if (folder === "inbox") return box.inboxLastSyncAt ?? null;
  if (folder === "junkemail") return box.junkLastSyncAt ?? null;
  return null;
}
