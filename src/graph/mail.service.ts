/**
 * Graph Mail operations used by Send + Inbox workers.
 *
 * Spec reference: https://learn.microsoft.com/graph/api/user-sendmail
 */

import { graphFetch, graphFetchAbsolute, graphSendMailMime, GraphApiError, graphFetchBinary } from "./client.js";
import { buildOutboundMimeMessage } from "../services/mime-mail.service.js";

export interface OutboundDraft {
  /** Sender mailbox UPN / SMTP address. */
  fromMailbox: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** HTML or text. We always send HTML in V1. */
  bodyHtml: string;
  /** When the body is plain text instead of HTML. */
  isHtml?: boolean;
  /** When set, send via MIME so List-Unsubscribe + List-Unsubscribe-Post headers are included (RFC 8058). */
  listUnsubscribeUrl?: string;
  /**
   * When set (with Notion Action = reply), send uses Graph `createReply` → PATCH
   * body → `send` so the mail stays in the same conversation/thread.
   * Value = Graph `id` of the **inbound** message in this mailbox (see Payload
   * `replyToGraphMessageId`, auto-written when an inbound reply is matched).
   */
  replyToGraphMessageId?: string;
}

/**
 * True in-thread reply: Graph creates a reply draft anchored on the given
 * message, we replace the body (HTML/text), optionally the subject line, then send.
 * Returns metadata for `outbound_messages` / Notion `_graph` (same shape as
 * `findRecentSentMessage`).
 *
 * Docs: https://learn.microsoft.com/graph/api/message-createreply
 */
function graphRecipientList(addrs: string[] | undefined): { emailAddress: { address: string } }[] {
  return (addrs ?? [])
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

export async function sendMailReplyInThread(params: {
  fromMailbox: string;
  replyToMessageId: string;
  bodyHtml: string;
  isHtml?: boolean;
  /** If non-empty, applied to the draft before send (otherwise Graph keeps "Re: …"). */
  subject?: string;
  /** Extra Cc on the reply draft (Graph `ccRecipients`). */
  cc?: string[];
  /** Extra Bcc on the reply draft (Graph `bccRecipients`). */
  bcc?: string[];
}): Promise<SentItemsLookupHit> {
  const { fromMailbox, replyToMessageId, bodyHtml, isHtml, subject, cc, bcc } = params;
  const encUser = encodeURIComponent(fromMailbox);
  const encParent = encodeURIComponent(replyToMessageId);

  const created = await graphFetch<{ id?: string }>({
    method: "POST",
    actorMailbox: fromMailbox,
    path: `/users/${encUser}/messages/${encParent}/createReply`,
    body: {},
  });
  const draftId = created?.id;
  if (!draftId) {
    throw new Error("createReply returned no draft message id");
  }
  const encDraft = encodeURIComponent(draftId);

  const ccRecipients = graphRecipientList(cc);
  const bccRecipients = graphRecipientList(bcc);
  const patch: Record<string, unknown> = {
    body: {
      contentType: isHtml === false ? "Text" : "HTML",
      content: bodyHtml,
    },
  };
  if (subject?.trim()) patch.subject = subject.trim();
  if (ccRecipients.length) patch.ccRecipients = ccRecipients;
  if (bccRecipients.length) patch.bccRecipients = bccRecipients;

  await graphFetch({
    method: "PATCH",
    actorMailbox: fromMailbox,
    path: `/users/${encUser}/messages/${encDraft}`,
    body: patch,
  });

  await graphFetch({
    method: "POST",
    actorMailbox: fromMailbox,
    path: `/users/${encUser}/messages/${encDraft}/send`,
    expectEmpty: true,
  });

  const meta = await graphFetch<{
    id: string;
    internetMessageId?: string | null;
    conversationId: string;
    sentDateTime: string;
    subject?: string;
  }>({
    method: "GET",
    actorMailbox: fromMailbox,
    path: `/users/${encUser}/messages/${encDraft}`,
    query: {
      $select: "id,internetMessageId,conversationId,sentDateTime,subject",
    },
  });

  return {
    graphMessageId: meta.id,
    internetMessageId: meta.internetMessageId ?? null,
    conversationId: meta.conversationId,
    sentAt: meta.sentDateTime,
    subject: meta.subject ?? subject?.trim() ?? "",
  };
}

/**
 * Send via /users/{email}/sendMail with `saveToSentItems=true`.
 * We DO NOT use createMessage+send so we don't have to manage drafts.
 *
 * NOTE: sendMail returns 202 Accepted with no body. We do a follow-up
 * GET to retrieve the saved Sent Items message metadata.
 */
export async function sendMail(draft: OutboundDraft): Promise<void> {
  if (draft.listUnsubscribeUrl?.trim()) {
    const mime = buildOutboundMimeMessage({
      fromMailbox: draft.fromMailbox,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      listUnsubscribeUrl: draft.listUnsubscribeUrl.trim(),
    });
    await graphSendMailMime(draft.fromMailbox, mime);
    return;
  }

  const recipients = (addrs: string[] | undefined) =>
    (addrs ?? [])
      .map((a) => a.trim())
      .filter(Boolean)
      .map((address) => ({ emailAddress: { address } }));

  await graphFetch({
    method: "POST",
    actorMailbox: draft.fromMailbox,
    path: `/users/${encodeURIComponent(draft.fromMailbox)}/sendMail`,
    expectEmpty: true,
    body: {
      message: {
        subject: draft.subject,
        body: {
          contentType: draft.isHtml === false ? "Text" : "HTML",
          content: draft.bodyHtml,
        },
        toRecipients: recipients(draft.to),
        ccRecipients: recipients(draft.cc),
        bccRecipients: recipients(draft.bcc),
      },
      saveToSentItems: true,
    },
  });
}

export interface SentItemsLookupHit {
  graphMessageId: string;
  internetMessageId: string | null;
  conversationId: string;
  sentAt: string;
  subject: string;
}

/**
 * sendMail does NOT return the new message id. Resolve it by polling the
 * sender's Sent Items folder for the most recent message that matches subject.
 *
 * Pragmatic match: same `subject` + first recipient + sent within last few minutes.
 * This is good enough for V1; minimal-server uses an analogous approach.
 */
export async function findRecentSentMessage(
  fromMailbox: string,
  subject: string,
  to: string,
  /** seconds, default 120 */
  withinSec = 120,
): Promise<SentItemsLookupHit | null> {
  const sinceIso = new Date(Date.now() - withinSec * 1000).toISOString();
  const filter = `sentDateTime ge ${sinceIso}`;
  const select =
    "id,internetMessageId,conversationId,sentDateTime,subject,toRecipients";

  const data = await graphFetch<{ value: any[] }>({
    method: "GET",
    actorMailbox: fromMailbox,
    path: `/users/${encodeURIComponent(fromMailbox)}/mailFolders/sentitems/messages`,
    query: {
      $filter: filter,
      $select: select,
      $orderby: "sentDateTime desc",
      $top: 25,
    },
  });

  const targetTo = to.trim().toLowerCase();
  for (const m of data?.value ?? []) {
    const msgSubj: string = m.subject ?? "";
    if (msgSubj !== subject) continue;
    const tos: string[] = (m.toRecipients ?? []).map((r: any) =>
      String(r?.emailAddress?.address ?? "").toLowerCase(),
    );
    if (targetTo && !tos.includes(targetTo)) continue;
    return {
      graphMessageId: m.id,
      internetMessageId: m.internetMessageId ?? null,
      conversationId: m.conversationId,
      sentAt: m.sentDateTime,
      subject: m.subject,
    };
  }
  return null;
}

type GraphMessageList = { value?: any[]; "@odata.nextLink"?: string };

function hitFromSentItem(m: any, subject: string, targetTo: string): boolean {
  const msgSubj: string = m.subject ?? "";
  if (msgSubj !== subject) return false;
  const tos: string[] = (m.toRecipients ?? []).map((r: any) =>
    String(r?.emailAddress?.address ?? "").toLowerCase(),
  );
  if (targetTo && !tos.includes(targetTo)) return false;
  return true;
}

/**
 * Scan Sent Items newest-first with **no** sentDateTime filter (subject + To must still match exactly).
 * Stops after `maxMessages` rows read across pages (Graph does not allow unbounded listing).
 */
async function scanSentItemsNewestFirst(
  fromMailbox: string,
  subject: string,
  toEmail: string,
  center: Date,
  maxMessages: number,
): Promise<SentItemsLookupHit | null> {
  const select = "id,internetMessageId,conversationId,sentDateTime,subject,toRecipients";
  const pageSize = 100;
  const path = `/users/${encodeURIComponent(fromMailbox)}/mailFolders/sentitems/messages`;
  const targetTo = toEmail.trim().toLowerCase();
  const centerMs = center.getTime();
  let best: { m: any; dist: number } | null = null;
  let scanned = 0;
  let nextUrl: string | undefined;

  for (;;) {
    const data: GraphMessageList = nextUrl
      ? await graphFetchAbsolute<GraphMessageList>(nextUrl, { actorMailbox: fromMailbox })
      : await graphFetch<GraphMessageList>({
          method: "GET",
          actorMailbox: fromMailbox,
          path,
          query: {
            $select: select,
            $orderby: "sentDateTime desc",
            $top: pageSize,
          },
        });

    for (const m of data?.value ?? []) {
      if (scanned >= maxMessages) break;
      scanned += 1;
      if (!hitFromSentItem(m, subject, targetTo)) continue;
      const sentMs = new Date(m.sentDateTime ?? 0).getTime();
      if (Number.isNaN(sentMs)) continue;
      const dist = Math.abs(sentMs - centerMs);
      if (!best || dist < best.dist) best = { m, dist };
    }

    if (scanned >= maxMessages) break;
    nextUrl = data?.["@odata.nextLink"];
    if (!nextUrl) break;
  }

  if (!best) return null;
  const m = best.m;
  return {
    graphMessageId: m.id,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId,
    sentAt: m.sentDateTime,
    subject: m.subject,
  };
}

export interface FindSentMessageNearDateOptions {
  /**
   * Search radius in hours on **each side** of `center` (total span ≈ 2 × this value).
   * Use **0** to disable the sentDateTime filter and scan Sent Items newest-first
   * up to `maxMessagesToScan` messages (still subject + To exact match).
   */
  windowHours?: number;
  /** Max rows returned in the single Graph request when using a time filter. Default 100. */
  top?: number;
  /** When `windowHours` is 0: stop after scanning this many messages across pages. Default 5000. */
  maxMessagesToScan?: number;
}

/**
 * Historical backfill: locate a Sent Items message near a known send time
 * (e.g. Notion Completion Time). Subject + first To must match exactly (same
 * limitation as {@link findRecentSentMessage}).
 */
export async function findSentMessageNearDate(
  fromMailbox: string,
  subject: string,
  toEmail: string,
  center: Date,
  options?: FindSentMessageNearDateOptions,
): Promise<SentItemsLookupHit | null> {
  const windowHours = options?.windowHours ?? 72;
  const top = options?.top ?? 100;
  const maxMessagesToScan = Math.max(100, options?.maxMessagesToScan ?? 5000);

  if (windowHours <= 0) {
    return scanSentItemsNewestFirst(fromMailbox, subject, toEmail, center, maxMessagesToScan);
  }

  const halfMs = Math.max(1, windowHours) * 3600 * 1000;
  const startIso = new Date(center.getTime() - halfMs).toISOString();
  const endIso = new Date(center.getTime() + halfMs).toISOString();
  const filter = `sentDateTime ge ${startIso} and sentDateTime le ${endIso}`;
  const select =
    "id,internetMessageId,conversationId,sentDateTime,subject,toRecipients";

  const data = await graphFetch<GraphMessageList>({
    method: "GET",
    actorMailbox: fromMailbox,
    path: `/users/${encodeURIComponent(fromMailbox)}/mailFolders/sentitems/messages`,
    query: {
      $filter: filter,
      $select: select,
      $orderby: "sentDateTime desc",
      $top: top,
    },
  });

  const targetTo = toEmail.trim().toLowerCase();
  const centerMs = center.getTime();
  let best: { m: any; dist: number } | null = null;

  for (const m of data?.value ?? []) {
    if (!hitFromSentItem(m, subject, targetTo)) continue;
    const sentMs = new Date(m.sentDateTime ?? 0).getTime();
    if (Number.isNaN(sentMs)) continue;
    const dist = Math.abs(sentMs - centerMs);
    if (!best || dist < best.dist) best = { m, dist };
  }

  if (!best) return null;
  const m = best.m;
  return {
    graphMessageId: m.id,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId,
    sentAt: m.sentDateTime,
    subject: m.subject,
  };
}

export interface InboxPullParams {
  mailbox: string;
  folder: string;
  /** ISO datetime; only fetch messages with receivedDateTime > this. */
  sinceIso?: string;
  pageSize?: number;
}

export interface InboxMessageSlim {
  id: string;
  internetMessageId: string | null;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
}

/**
 * Pull inbound messages from a well-known folder name (e.g. inbox, junkemail).
 * Returns slim payloads to keep PG rows small.
 */
export async function pullFolderMessages(
  params: InboxPullParams,
): Promise<InboxMessageSlim[]> {
  const select =
    "id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients";
  const filter = params.sinceIso ? `receivedDateTime gt ${params.sinceIso}` : undefined;

  const data = await graphFetch<{ value: InboxMessageSlim[] }>({
    method: "GET",
    actorMailbox: params.mailbox,
    path: `/users/${encodeURIComponent(params.mailbox)}/mailFolders/${params.folder}/messages`,
    query: {
      $select: select,
      $orderby: "receivedDateTime asc",
      $top: params.pageSize ?? 50,
      ...(filter ? { $filter: filter } : {}),
    },
  });
  return data?.value ?? [];
}

/**
 * Fetch a single message by Graph id (used by webhook ingest path).
 * Returns `null` on 404 (deleted / moved).
 */
export async function getMessageById(
  mailboxKey: string,
  messageId: string,
): Promise<InboxMessageSlim | null> {
  const select =
    "id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients";
  try {
    return (await graphFetch<InboxMessageSlim>({
      method: "GET",
      actorMailbox: mailboxKey,
      path: `/users/${encodeURIComponent(mailboxKey)}/messages/${encodeURIComponent(messageId)}`,
      query: { $select: select },
    })) as InboxMessageSlim;
  } catch (e: unknown) {
    if (e instanceof GraphApiError && e.status === 404) return null;
    throw e;
  }
}

/** Internet headers for auto-reply detection (match worker only — extra Graph round-trip). */
export async function getMessageInternetHeaders(
  mailboxKey: string,
  messageId: string,
): Promise<Array<{ name: string; value: string }>> {
  try {
    const data = await graphFetch<{
      internetMessageHeaders?: Array<{ name?: string; value?: string }>;
    }>({
      method: "GET",
      actorMailbox: mailboxKey,
      path: `/users/${encodeURIComponent(mailboxKey)}/messages/${encodeURIComponent(messageId)}`,
      query: { $select: "internetMessageHeaders" },
    });
    return (data.internetMessageHeaders ?? []).map((h) => ({
      name: String(h.name ?? ""),
      value: String(h.value ?? ""),
    }));
  } catch (e: unknown) {
    if (e instanceof GraphApiError && e.status === 404) return [];
    throw e;
  }
}

export interface GraphMessageBody {
  contentType?: string;
  content?: string;
}

export interface GraphAttachmentMeta {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
}

/** Full message for admin UI (HTML body + attachment metadata). */
export async function getMessageFullForAdmin(
  mailbox: string,
  messageId: string,
): Promise<{
  id: string;
  subject?: string;
  body?: GraphMessageBody;
  hasAttachments?: boolean;
  attachments: GraphAttachmentMeta[];
} | null> {
  try {
    const data = await graphFetch<{
      id: string;
      subject?: string;
      body?: GraphMessageBody;
      hasAttachments?: boolean;
    }>({
      method: "GET",
      actorMailbox: mailbox,
      path: `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`,
      query: {
        $select: "id,subject,body,hasAttachments",
      },
    });
    let attachments: GraphAttachmentMeta[] = [];
    if (data.hasAttachments) {
      const attData = await graphFetch<{ value?: GraphAttachmentMeta[] }>({
        method: "GET",
        actorMailbox: mailbox,
        path: `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`,
        query: { $select: "id,name,contentType,size,isInline" },
      });
      attachments = attData.value ?? [];
    }
    return { ...data, attachments };
  } catch (e: unknown) {
    if (e instanceof GraphApiError && e.status === 404) return null;
    throw e;
  }
}

export async function downloadAttachmentBytes(params: {
  mailbox: string;
  messageId: string;
  attachmentId: string;
}): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const { mailbox, messageId, attachmentId } = params;
  /** Do not use a narrow `$select`: Graph must return `@odata.type` so we only call `/$value` for fileAttachment. */
  const meta = await graphFetch<Record<string, unknown>>({
    method: "GET",
    actorMailbox: mailbox,
    path: `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  });
  const odataType = String(meta["@odata.type"] ?? "");
  if (!odataType.toLowerCase().includes("fileattachment")) {
    throw new GraphApiError(
      `Attachment download only supports #microsoft.graph.fileAttachment; got ${odataType || "(missing @odata.type)"}`,
      415,
      "unsupportedAttachmentType",
      meta,
    );
  }
  const path = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`;
  const buffer = await graphFetchBinary({ path, actorMailbox: mailbox });
  const name = typeof meta.name === "string" ? meta.name : undefined;
  const contentType = typeof meta.contentType === "string" ? meta.contentType : undefined;
  return {
    buffer,
    contentType: contentType || "application/octet-stream",
    filename: name || "attachment",
  };
}
