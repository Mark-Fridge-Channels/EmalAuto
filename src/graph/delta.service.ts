/**
 * Delta query for mail folder messages — compensates for missed webhooks.
 *
 * Docs: https://learn.microsoft.com/graph/delta-query-messages
 */

import { graphFetchAbsolute } from "./client.js";
import { ingestInboxMessageBatch } from "../services/inbox-ingest.service.js";
import type { InboxMessageSlim } from "./mail.service.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

interface DeltaResponse {
  value?: InboxMessageSlim[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const DELTA_SELECT =
  "id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients";

export interface DeltaSyncResult {
  /** Latest `@odata.deltaLink` from Graph (store in PG). */
  deltaLink: string | null;
  /** Max `receivedDateTime` among rows we attempted to ingest this run (for cursor). */
  maxReceivedAt: Date | null;
}

/**
 * Walks `@odata.nextLink` until `@odata.deltaLink` is returned, ingesting
 * every **message** row (skips `@removed` tombstones and malformed items).
 */
export async function runDeltaSyncForFolder(params: {
  mailboxId: number;
  mailboxEmail: string;
  folder: string;
  /** Stored delta URL from PG; `null` starts a brand-new baseline delta. */
  deltaLink: string | null;
}): Promise<DeltaSyncResult> {
  const start =
    params.deltaLink ??
    `${GRAPH_ROOT}/users/${encodeURIComponent(params.mailboxEmail)}/mailFolders/${encodeURIComponent(params.folder)}/messages/delta?$select=${encodeURIComponent(DELTA_SELECT)}`;

  let url: string | undefined = start;
  let latestDelta: string | null = null;
  let globalMax: Date | null = null;

  while (url) {
    const page: DeltaResponse = await graphFetchAbsolute<DeltaResponse>(url, {
      actorMailbox: params.mailboxEmail,
    });
    const rawItems = page.value ?? [];
    const messages: InboxMessageSlim[] = [];
    for (const item of rawItems as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (o["@odata.type"] === "#microsoft.graph.message" || o.id) {
        messages.push(o as unknown as InboxMessageSlim);
      }
    }
    const { maxReceivedAt } = await ingestInboxMessageBatch(messages, params.mailboxId, params.folder);
    if (maxReceivedAt && (!globalMax || maxReceivedAt > globalMax)) globalMax = maxReceivedAt;

    if (page["@odata.deltaLink"]) latestDelta = page["@odata.deltaLink"] as string;
    url = page["@odata.nextLink"] ?? undefined;
  }
  return { deltaLink: latestDelta, maxReceivedAt: globalMax };
}
