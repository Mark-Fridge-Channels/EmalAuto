/**
 * Heuristic bounce / non-delivery detector.
 *
 * Strategy (short-circuit in order):
 *   (a) `from` matches known NDR / mailer-daemon senders
 *   (b) `subject` matches a known bounce phrase (EN/CN/JA)
 *   (c) `bodyPreview` matches NDR body phrases (Office 365 often keeps the original Re: subject)
 *   (d) `headers` — multipart/report delivery-status, failed-recipient headers
 *
 * If any step matches, we treat it as a bounce. The matcher then tries to associate
 * it back to the original outbound by `conversationId` or failed recipient email.
 */

const FROM_BOUNCE_PATTERNS = [
  /mailer-daemon/i,
  /postmaster@/i,
  /^microsoftexchange[a-f0-9]+@.+\.onmicrosoft\.com$/i,
];

const SUBJECT_BOUNCE_PATTERNS = [
  /undeliverable/i,
  /delivery status notification/i,
  /returned mail/i,
  /mail delivery failed/i,
  /delivery failure/i,
  /your message couldn['']t be delivered/i,
  /couldn['']t deliver the message/i,
  /address not found/i,
  /delivery has failed/i,
  /無法投遞/, // zh-TW
  /无法投递/, // zh-CN
  /無法配信/, // ja
];

const BODY_BOUNCE_PATTERNS = [
  /your message couldn['']t be delivered/i,
  /couldn['']t deliver the message/i,
  /message could not be delivered/i,
  /delivery status notification/i,
  /remote server returned message/i,
  /status code:\s*\d{3}/i,
  /wasn['']t delivered to\s+[a-z0-9._%+-]+@/i,
  /message you sent to\s+[a-z0-9._%+-]+@/i,
];

function headerMap(headers: Array<{ name?: string; value?: string }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers) {
    const name = String(h.name ?? "").trim().toLowerCase();
    if (!name) continue;
    m.set(name, String(h.value ?? "").trim());
  }
  return m;
}

function classifyFromHeaders(headers: Array<{ name?: string; value?: string }>): string | null {
  const h = headerMap(headers);

  const contentType = h.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/report") && contentType.includes("report-type=delivery-status")) {
    return "header Content-Type=multipart/report; report-type=delivery-status";
  }

  if (h.has("x-failed-recipients")) {
    return "header X-Failed-Recipients";
  }

  return null;
}

export interface BounceVerdict {
  isBounce: boolean;
  reason: string;
}

export function detectBounce(input: {
  fromEmail: string;
  subject: string;
  bodyPreview?: string;
  headers?: Array<{ name?: string; value?: string }>;
}): BounceVerdict {
  const from = (input.fromEmail ?? "").toLowerCase();
  const subj = input.subject ?? "";
  const body = input.bodyPreview ?? "";

  for (const p of FROM_BOUNCE_PATTERNS) {
    if (p.test(from)) return { isBounce: true, reason: `from matched ${p}` };
  }
  for (const p of SUBJECT_BOUNCE_PATTERNS) {
    if (p.test(subj)) return { isBounce: true, reason: `subject matched ${p}` };
  }
  for (const p of BODY_BOUNCE_PATTERNS) {
    if (p.test(body)) return { isBounce: true, reason: `body matched ${p}` };
  }

  if (input.headers?.length) {
    const fromHeaders = classifyFromHeaders(input.headers);
    if (fromHeaders) return { isBounce: true, reason: fromHeaders };
  }

  return { isBounce: false, reason: "" };
}
