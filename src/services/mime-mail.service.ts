/**
 * RFC 5322 MIME builder for Graph `sendMail` (Content-Type: text/plain, body = base64 MIME).
 * Used when RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers are required.
 */

import { randomBytes } from "node:crypto";

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

/**
 * RFC 5322 List-Unsubscribe — fold only at the comma between mailto and https.
 * Never fold inside `https://` (76-char folding breaks the URL).
 */
function formatListUnsubscribeHeader(value: string): string {
  const prefix = "List-Unsubscribe: ";
  const full = `${prefix}${value}`;
  if (full.length <= 998) return full;

  const match = value.match(/^(<mailto:[^>]+>),\s*(<https?:\/\/[^>]+>)$/);
  if (match) {
    return `${prefix}${match[1]},\r\n ${match[2]}`;
  }
  return full;
}

function formatFrom(mailbox: string): string {
  const email = mailbox.trim();
  const name = signatureNameFromMailbox(email);
  return name ? `${name} <${email}>` : email;
}

function formatAddressList(addrs: string[]): string {
  return addrs.map((a) => a.trim()).filter(Boolean).join(", ");
}

function formatRfc2822Date(date = new Date()): string {
  return date.toUTCString().replace("GMT", "+0000");
}

function messageIdFromMailbox(mailbox: string): string {
  const domain = mailbox.trim().split("@")[1] ?? "localhost";
  const token = randomBytes(16).toString("hex");
  return `<${token}@${domain}>`;
}

function mimeBoundary(): string {
  return `----=_Part_${randomBytes(8).toString("hex")}`;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build a multipart/alternative HTML MIME message with RFC 8058 unsubscribe headers. */
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
  const boundary = mimeBoundary();
  const plainText = htmlToPlainText(params.bodyHtml);
  const plainB64 = foldBase64(Buffer.from(plainText, "utf8").toString("base64"));
  const htmlB64 = foldBase64(Buffer.from(params.bodyHtml, "utf8").toString("base64"));

  const envelopeHeaders = [
    `From: ${formatFrom(params.fromMailbox)}`,
    `To: ${formatAddressList(params.to)}`,
    params.cc?.length ? `Cc: ${formatAddressList(params.cc)}` : null,
    params.bcc?.length ? `Bcc: ${formatAddressList(params.bcc)}` : null,
    `Subject: ${params.subject}`,
    `Date: ${formatRfc2822Date()}`,
    `Message-ID: ${messageIdFromMailbox(params.fromMailbox)}`,
    "MIME-Version: 1.0",
    formatListUnsubscribeHeader(listUnsub),
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter((line): line is string => line != null);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    plainB64,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    `--${boundary}--`,
  ];

  return crlfJoin([...envelopeHeaders, "", ...parts]);
}
