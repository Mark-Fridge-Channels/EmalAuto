/**
 * Heuristic auto-reply vs human reply classifier (RFC 3834 headers + subject/body).
 */

export type ReplyKind = "human" | "auto";

export interface ReplyKindVerdict {
  kind: ReplyKind;
  reason: string;
}

const SUBJECT_AUTO_PATTERNS = [
  /out\s*of\s*office/i,
  /automatic\s+reply/i,
  /auto[\s-]?reply/i,
  /vacation\s+reply/i,
  /away\s+from\s+(the\s+)?office/i,
  /delivery\s+notification/i,
  /undeliverable/i,
  /不在办公室/,
  /外出/,
  /休假/,
  /自動返信/,
  /自動回覆/,
  /不在席/,
];

const BODY_AUTO_PATTERNS = [
  /i am currently out of the office/i,
  /i will be out of the office/i,
  /this is an automated (message|response|reply)/i,
  /do not reply to this (message|email)/i,
  /automatically generated/i,
];

/** `Auto-Submitted` values that indicate a machine-generated reply (RFC 3834). */
const AUTO_SUBMITTED_VALUES = new Set([
  "auto-replied",
  "auto-generated",
  "auto-notified",
]);

const PRECEDENCE_AUTO = new Set(["auto_reply", "bulk", "junk", "list"]);

function headerMap(headers: Array<{ name?: string; value?: string }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers) {
    const name = String(h.name ?? "").trim().toLowerCase();
    if (!name) continue;
    m.set(name, String(h.value ?? "").trim());
  }
  return m;
}

function classifyFromHeaders(headers: Array<{ name?: string; value?: string }>): ReplyKindVerdict | null {
  const h = headerMap(headers);

  const autoSubmitted = h.get("auto-submitted")?.toLowerCase() ?? "";
  if (autoSubmitted && autoSubmitted !== "no") {
    const first = autoSubmitted.split(";")[0]?.trim() ?? autoSubmitted;
    if (AUTO_SUBMITTED_VALUES.has(first) || first.startsWith("auto-")) {
      return { kind: "auto", reason: `header Auto-Submitted=${autoSubmitted}` };
    }
  }

  const precedence = h.get("precedence")?.toLowerCase() ?? "";
  if (precedence) {
    const token = precedence.split(/[,\s]+/)[0]?.trim() ?? precedence;
    if (PRECEDENCE_AUTO.has(token)) {
      return { kind: "auto", reason: `header Precedence=${precedence}` };
    }
  }

  const msSrc = h.get("x-ms-exchange-generated-message-source")?.toLowerCase() ?? "";
  if (msSrc.includes("mailbox rules agent") || msSrc.includes("oof")) {
    return { kind: "auto", reason: `header X-MS-Exchange-Generated-Message-Source=${msSrc}` };
  }

  return null;
}

export function detectReplyKind(input: {
  subject: string;
  bodyPreview: string;
  headers?: Array<{ name?: string; value?: string }>;
}): ReplyKindVerdict {
  if (input.headers?.length) {
    const fromHeaders = classifyFromHeaders(input.headers);
    if (fromHeaders) return fromHeaders;
  }

  const subj = input.subject ?? "";
  for (const p of SUBJECT_AUTO_PATTERNS) {
    if (p.test(subj)) return { kind: "auto", reason: `subject matched ${p}` };
  }

  const body = input.bodyPreview ?? "";
  for (const p of BODY_AUTO_PATTERNS) {
    if (p.test(body)) return { kind: "auto", reason: `body matched ${p}` };
  }

  return { kind: "human", reason: "no auto-reply signals" };
}
