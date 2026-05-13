/**
 * Graph Mail operations used by Send + Inbox workers.
 *
 * Spec reference: https://learn.microsoft.com/graph/api/user-sendmail
 */

import { graphFetch, GraphApiError } from "./client.js";

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
export async function sendMailReplyInThread(params: {
  fromMailbox: string;
  replyToMessageId: string;
  bodyHtml: string;
  isHtml?: boolean;
  /** If non-empty, applied to the draft before send (otherwise Graph keeps "Re: …"). */
  subject?: string;
}): Promise<SentItemsLookupHit> {
  const { fromMailbox, replyToMessageId, bodyHtml, isHtml, subject } = params;
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

  await graphFetch({
    method: "PATCH",
    actorMailbox: fromMailbox,
    path: `/users/${encUser}/messages/${encDraft}`,
    body: {
      body: {
        contentType: isHtml === false ? "Text" : "HTML",
        content: bodyHtml,
      },
      ...(subject && subject.trim() ? { subject: subject.trim() } : {}),
    },
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
