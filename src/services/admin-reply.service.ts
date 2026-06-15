/**
 * Admin console: send an in-thread reply anchored on an `inbox_messages` row.
 */

import { loadConfig } from "../config/index.js";
import { findInboxById } from "../db/repositories/inbox.repo.js";
import { findMailboxById } from "../db/repositories/mailbox.repo.js";
import { db } from "../db/client.js";
import { outboundMessages, type NewOutboundMessage } from "../db/schema/outbound_messages.js";
import { eq } from "drizzle-orm";
import { sendMailReplyInThread } from "../graph/mail.service.js";
import { recordOutbound } from "../services/message-store.service.js";
import { createWebReplyNotionPage, writeSendSuccess } from "../notion/writer.js";
import { logger } from "../utils/logger.js";
import { ensureOutboundMailBody } from "./mail-signature.service.js";

export async function executeAdminInboxReply(params: {
  inboxRowId: number;
  bodyHtml: string;
  subject?: string;
  cc?: string[];
  bcc?: string[];
}): Promise<{ outboundId: number; notionPageId: string | null }> {
  const row = await findInboxById(params.inboxRowId);
  if (!row) throw new Error("inbox row not found");

  const mailbox = await findMailboxById(row.mailboxId);
  if (!mailbox) throw new Error("mailbox not found");

  let parentNotionPageId: string | null = null;
  if (row.matchedOutboundId) {
    const [ob] = await db
      .select({ notionPageId: outboundMessages.notionPageId })
      .from(outboundMessages)
      .where(eq(outboundMessages.id, row.matchedOutboundId));
    parentNotionPageId = ob?.notionPageId ?? null;
  }

  let newNotionPageId: string | null = null;
  const cfg = loadConfig();
  const signedBodyHtml = ensureOutboundMailBody(
    params.bodyHtml,
    mailbox.email,
    true,
    cfg.mail.opt_out_footer_text,
  );
  if (parentNotionPageId) {
    newNotionPageId = await createWebReplyNotionPage({
      receivingMailbox: mailbox.email,
      counterpartyEmail: row.fromEmail,
      subject: params.subject?.trim() || row.subject || "(no subject)",
      bodyHtml: signedBodyHtml,
      replyAnchorGraphMessageId: row.graphMessageId,
      conversationId: row.conversationId,
      parentOutboundNotionPageId: parentNotionPageId,
    });
  }

  const cc = (params.cc ?? []).map((e) => e.trim()).filter(Boolean);
  const bcc = (params.bcc ?? []).map((e) => e.trim()).filter(Boolean);

  try {
    const hit = await sendMailReplyInThread({
      fromMailbox: mailbox.email,
      replyToMessageId: row.graphMessageId,
      bodyHtml: signedBodyHtml,
      isHtml: true,
      subject: params.subject?.trim() || undefined,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
    });
    const sentAt = new Date(hit.sentAt);

    if (newNotionPageId) {
      await writeSendSuccess(newNotionPageId, {
        graphMessageId: hit.graphMessageId,
        conversationId: hit.conversationId,
        internetMessageId: hit.internetMessageId,
        sentAt,
      });
    }

    const recipientsJson = {
      to: [row.fromEmail],
      cc,
      bcc,
    } satisfies { to: string[]; cc: string[]; bcc: string[] };

    const metaJson = { actionType: "web_console_reply" as const };

    const inserted = await recordOutbound({
      mailboxId: mailbox.id,
      notionPageId: newNotionPageId,
      graphMessageId: hit.graphMessageId,
      internetMessageId: hit.internetMessageId,
      conversationId: hit.conversationId,
      subject: hit.subject,
      body: signedBodyHtml,
      sentAt,
      recipientsJson: recipientsJson as NewOutboundMessage["recipientsJson"],
      metaJson: metaJson as NewOutboundMessage["metaJson"],
      threadStatus: "sent",
    });

    logger.info(
      { inboxRowId: row.id, outboundId: inserted.id, notionPageId: newNotionPageId },
      "admin reply sent",
    );

    return { outboundId: inserted.id, notionPageId: newNotionPageId };
  } catch (err) {
    if (newNotionPageId) {
      logger.error(
        { err, newNotionPageId },
        "admin reply: Graph send failed after Notion page was created — manual cleanup may be needed",
      );
    }
    throw err;
  }
}
