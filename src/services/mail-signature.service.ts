/**
 * Sender signature normalization shared by automated Notion sends and manual web replies.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

export function signatureNameFromMailbox(mailbox: string): string {
  const local = String(mailbox ?? "")
    .trim()
    .split("@")[0]
    ?.split("+")[0]
    ?.trim();
  if (!local) return "";

  return local
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function authoredHtmlPart(bodyHtml: string): string {
  const marker = bodyHtml.search(/<(?:hr|blockquote)\b/i);
  return marker >= 0 ? bodyHtml.slice(0, marker) : bodyHtml;
}

function hasSignature(body: string, signatureName: string, isHtml: boolean): boolean {
  const source = isHtml ? stripHtmlToText(authoredHtmlPart(body)) : String(body ?? "");
  const sig = signatureName.trim().toLowerCase();
  if (!sig) return true;

  const lines = source
    .split(/\n+/)
    .map((line) => line.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean);

  return lines.some((line) => {
    if (line === sig) return true;
    return new RegExp(`^(best regards|regards|thanks|thank you|cheers|sincerely|best)[,，]?\\s+${sig}$`, "i").test(
      line,
    );
  });
}

function appendHtmlSignature(bodyHtml: string, signatureName: string): string {
  const marker = bodyHtml.search(/<(?:hr|blockquote)\b/i);
  const beforeQuote = marker >= 0 ? bodyHtml.slice(0, marker).trimEnd() : bodyHtml.trimEnd();
  const quote = marker >= 0 ? bodyHtml.slice(marker) : "";
  const prefix = beforeQuote ? beforeQuote : "";
  return `${prefix}<p>${escapeHtml(signatureName)}</p>${quote}`;
}

export function ensureSenderSignature(body: string, fromMailbox: string, isHtml: boolean): string {
  const signatureName = signatureNameFromMailbox(fromMailbox);
  if (!signatureName || hasSignature(body, signatureName, isHtml)) return body;
  if (isHtml) return appendHtmlSignature(body, signatureName);
  return `${String(body ?? "").trimEnd()}\n\n${signatureName}`;
}
