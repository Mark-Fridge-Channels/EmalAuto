/**
 * Heuristic bounce / non-delivery detector.
 *
 * Strategy (short-circuit in order):
 *   (a) `from` contains MAILER-DAEMON / postmaster@
 *   (b) `subject` matches a known bounce phrase (EN/CN/JA)
 *
 * If a row passes (a) OR (b), we treat it as a bounce. The matcher then tries
 * to associate it back to the original outbound by `conversationId`
 * (Exchange usually preserves it for NDRs).
 */

const FROM_BOUNCE_PATTERNS = [/mailer-daemon/i, /postmaster@/i];

const SUBJECT_BOUNCE_PATTERNS = [
  /undeliverable/i,
  /delivery status notification/i,
  /returned mail/i,
  /mail delivery failed/i,
  /delivery failure/i,
  /無法投遞/, // zh-TW
  /无法投递/, // zh-CN
  /無法配信/, // ja
];

export interface BounceVerdict {
  isBounce: boolean;
  reason: string;
}

export function detectBounce(input: {
  fromEmail: string;
  subject: string;
}): BounceVerdict {
  const from = (input.fromEmail ?? "").toLowerCase();
  const subj = input.subject ?? "";

  for (const p of FROM_BOUNCE_PATTERNS) {
    if (p.test(from)) return { isBounce: true, reason: `from matched ${p}` };
  }
  for (const p of SUBJECT_BOUNCE_PATTERNS) {
    if (p.test(subj)) return { isBounce: true, reason: `subject matched ${p}` };
  }
  return { isBounce: false, reason: "" };
}
