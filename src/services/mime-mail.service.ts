/**
 * RFC 5322 MIME builder for Graph `sendMail` (Content-Type: text/plain, body = base64 MIME).
 * Used when RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers are required.
 */

import { signatureNameFromMailbox } from "./mail-signature.service.js";
import { buildListUnsubscribeHeaderValue } from "./list-unsubscribe.service.js";

function crlfJoin(lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

function foldBase64(b64: string, lineLen = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += lineLen) {
    lines.push(b64.slice(i, i + lineLen));
  }
  return lines.join("\r\n");
}

function formatFrom(mailbox: string): string {
  const email = mailbox.trim();
  const name = signatureNameFromMailbox(email);
  return name ? `${name} <${email}>` : email;
}

function formatAddressList(addrs: string[]): string {
  return addrs.map((a) => a.trim()).filter(Boolean).join(", ");
}

/** Build a single-part HTML MIME message with RFC 8058 unsubscribe headers. */
export function buildOutboundMimeMessage(params: {
  fromMailbox: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  listUnsubscribeUrl: string;
}): string {
  const listUnsub = buildListUnsubscribeHeaderValue(params.fromMailbox, params.listUnsubscribeUrl);
  const bodyB64 = foldBase64(Buffer.from(params.bodyHtml, "utf8").toString("base64"));

  const headers = [
    `From: ${formatFrom(params.fromMailbox)}`,
    `To: ${formatAddressList(params.to)}`,
    params.cc?.length ? `Cc: ${formatAddressList(params.cc)}` : "",
    params.bcc?.length ? `Bcc: ${formatAddressList(params.bcc)}` : "",
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    `List-Unsubscribe: ${listUnsub}`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyB64,
  ];

  return crlfJoin(headers);
}
