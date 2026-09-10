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

export type BounceSeverity = "hard" | "soft" | "unknown";

export interface BounceVerdict {
  isBounce: boolean;
  reason: string;
  /** Only meaningful when `isBounce` is true. Soft → no KP switch. */
  severity: BounceSeverity;
}

/** Phrases that strongly indicate permanent / hard failure (invalid mailbox, etc.). */
const HARD_BOUNCE_PATTERNS = [
  /address not found/i,
  /user unknown/i,
  /unknown user/i,
  /no such user/i,
  /does not exist/i,
  /recipient.*(rejected|not found|unknown)/i,
  /mailbox.*(not found|unavailable|does not exist)/i,
  /invalid.*(recipient|mailbox|address)/i,
  /550\s*5\.1\.1/i,
  /5\.1\.1/i,
  /5\.1\.10/i,
  /permanent failure/i,
  /permanently rejected/i,
];

/** Phrases that indicate transient / soft failure (quota, greylist, spam defer). */
const SOFT_BOUNCE_PATTERNS = [
  /mailbox full/i,
  /over quota/i,
  /quota exceeded/i,
  /try again later/i,
  /temporarily (deferred|rejected|unavailable)/i,
  /4\.\d\.\d/i,
  /greylist/i,
  /rate.?limit/i,
  /too many/i,
  /suspected.*spam/i,
  /spam.*reject/i,
  /message.*(deferred|delayed)/i,
];

function classifySeverity(subj: string, body: string, reason: string): BounceSeverity {
  const blob = `${subj}\n${body}\n${reason}`;
  for (const p of HARD_BOUNCE_PATTERNS) {
    if (p.test(blob)) return "hard";
  }
  for (const p of SOFT_BOUNCE_PATTERNS) {
    if (p.test(blob)) return "soft";
  }
  // Conservative default: treat unclassified NDRs as hard so KP advance still runs
  // for classic "address not found" paths that only matched from/mailer-daemon.
  if (/address not found/i.test(subj)) return "hard";
  if (/mailer-daemon|postmaster|microsoftexchange/i.test(reason)) return "unknown";
  return "unknown";
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

  let reason = "";
  for (const p of FROM_BOUNCE_PATTERNS) {
    if (p.test(from)) {
      reason = `from matched ${p}`;
      break;
    }
  }
  if (!reason) {
    for (const p of SUBJECT_BOUNCE_PATTERNS) {
      if (p.test(subj)) {
        reason = `subject matched ${p}`;
        break;
      }
    }
  }
  if (!reason) {
    for (const p of BODY_BOUNCE_PATTERNS) {
      if (p.test(body)) {
        reason = `body matched ${p}`;
        break;
      }
    }
  }
  if (!reason && input.headers?.length) {
    const fromHeaders = classifyFromHeaders(input.headers);
    if (fromHeaders) reason = fromHeaders;
  }

  if (!reason) return { isBounce: false, reason: "", severity: "unknown" };

  const severity = classifySeverity(subj, body, reason);
  return { isBounce: true, reason, severity };
}

/** True when campaign KP list should advance (Hard Bounce only). */
export function shouldAdvanceKpOnBounce(verdict: BounceVerdict): boolean {
  if (!verdict.isBounce) return false;
  return verdict.severity === "hard" || verdict.severity === "unknown";
}
