/**
 * Shared path: Graph message → `inbox_messages` row → `match` queue.
 * Used by polling worker, delta sync, and webhook ingest worker.
 */

import { matchQueue } from "../queues/queues.js";
import { insertInboxIfNew } from "../db/repositories/inbox.repo.js";
import type { InboxMessageSlim } from "../graph/mail.service.js";

function extractFromEmail(m: InboxMessageSlim): string {
  return String(m.from?.emailAddress?.address ?? "").toLowerCase();
}

export interface IngestBatchResult {
  written: number;
  maxReceivedAt: Date | null;
}

/**
 * Insert each message once; enqueue match jobs for fresh rows only.
 */
export async function ingestInboxMessageBatch(
  messages: InboxMessageSlim[],
  mailboxId: number,
  folder: string,
): Promise<IngestBatchResult> {
  let written = 0;
  let maxReceivedAt: Date | null = null;
  for (const m of messages) {
    if (!m?.id || !m.conversationId) continue;
    const receivedAt = new Date(m.receivedDateTime);
    if (!maxReceivedAt || receivedAt > maxReceivedAt) maxReceivedAt = receivedAt;

    const inserted = await insertInboxIfNew({
      mailboxId,
      folder,
      graphMessageId: m.id,
      internetMessageId: m.internetMessageId,
      conversationId: m.conversationId,
      fromEmail: extractFromEmail(m),
      recipientsJson: {
        to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? ""),
        cc: (m.ccRecipients ?? []).map((r) => r.emailAddress?.address ?? ""),
      } as any,
      subject: m.subject ?? "",
      receivedAt,
      bodyPreview: m.bodyPreview ?? "",
      rawJson: m as any,
      matchStatus: "unmatched",
    });
    if (!inserted) continue;
    written += 1;
    await matchQueue.add("match", { inboxRowId: inserted.id }, { jobId: `match__${inserted.id}` });
  }
  return { written, maxReceivedAt };
}
