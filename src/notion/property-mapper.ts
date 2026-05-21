/**
 * Notion property reading & writing helpers.
 *
 * Faithful TypeScript port of the patterns in minimal-server/queueParser.js
 * (key alias tolerance, status/select dual support, rich_text→HTML for body)
 * — but only what this project actually needs.
 *
 * Naming: "semantic key" (e.g. `subject`) vs "actual Notion column name"
 * (e.g. `Outreach Subject`). The mapping is configured per deployment.
 */

import type { AppConfig } from "../config/index.js";

/* ------------------------- Read helpers ------------------------- */

export function firstDefined<T extends Record<string, unknown>>(
  obj: T | undefined,
  keys: string[],
): unknown | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
}

function concatPlain(arr: any): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((x) => (x?.plain_text ?? "") as string).join("").trim();
}

export function readRichText(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text") return concatPlain(prop.rich_text);
  if (prop.type === "title") return concatPlain(prop.title);
  return "";
}

/** select OR status (Notion treats them as different types). */
export function readSelectOrStatus(prop: any): string {
  if (!prop) return "";
  if (prop.type === "select") return (prop.select?.name ?? "").trim();
  if (prop.type === "status") return (prop.status?.name ?? "").trim();
  return "";
}

export function readEmail(prop: any): string {
  if (prop?.type === "email" && prop.email) return String(prop.email).trim();
  return "";
}

/** Split comma/semicolon/whitespace-separated addresses; normalize + dedupe. */
export function parseEmailListFromText(raw: string): string[] {
  const parts = String(raw ?? "")
    .split(/[,;]+/)
    .flatMap((chunk) => chunk.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const e = normalizeEmail(p);
    if (!/@/.test(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** Read CC/BCC-style lists from rich_text, title, or email properties. */
export function readCommaSeparatedEmails(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const o = prop as Record<string, unknown>;
  if (o.type === "email" && o.email) {
    const e = normalizeEmail(String(o.email));
    return /@/.test(e) ? [e] : [];
  }
  return parseEmailListFromText(readRichText(prop as never));
}

export function mergeEmailLists(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const e = normalizeEmail(raw);
      if (!/@/.test(e) || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

export function readDateStart(prop: any): string {
  if (prop?.type !== "date") return "";
  return String(prop.date?.start ?? "").trim();
}

export function readDateEnd(prop: any): string {
  if (prop?.type !== "date") return "";
  return String(prop.date?.end ?? "").trim();
}

export function readFormulaText(prop: any): string {
  if (prop?.type !== "formula" || !prop.formula) return "";
  const f = prop.formula;
  if (f.type === "string") return String(f.string ?? "").trim();
  if (f.type === "number" && f.number != null) return String(f.number).trim();
  if (f.type === "boolean") return f.boolean ? "true" : "false";
  if (f.type === "date" && f.date?.start) return String(f.date.start).trim();
  return "";
}

/* ------------------------- HTML conversion ------------------------- */

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHttpHref(url: string): string {
  const u = String(url ?? "").trim();
  return /^https?:\/\//i.test(u) ? u : "";
}

/**
 * Notion stores hyperlinks in rich_text runs as text.link.url, not in plain_text.
 * concatPlain alone loses links; this preserves links + basic formatting as HTML.
 * Mirrors minimal-server/queueParser.js richTextPropertyToHtml().
 */
export function richTextPropertyToHtml(prop: any): string {
  if (prop?.type !== "rich_text" || !Array.isArray(prop.rich_text)) return "";
  let out = "";
  for (const rt of prop.rich_text) {
    const content = rt?.plain_text ?? "";
    const url = sanitizeHttpHref(rt?.text?.link?.url ?? rt?.href ?? "");
    let frag = escapeHtml(content).replace(/\n/g, "<br>");
    if (url) frag = `<a href="${escapeHtml(url)}">${frag}</a>`;
    if (rt?.annotations?.code) frag = `<code>${frag}</code>`;
    if (rt?.annotations?.bold) frag = `<strong>${frag}</strong>`;
    if (rt?.annotations?.italic) frag = `<em>${frag}</em>`;
    if (rt?.annotations?.strikethrough) frag = `<s>${frag}</s>`;
    if (rt?.annotations?.underline) frag = `<u>${frag}</u>`;
    out += frag;
  }
  return out;
}

/* ------------------------- Property name resolver ------------------------- */

/**
 * Build a resolver tied to the user's notion_property_names config.
 * Each "semantic key" maps to: [primaryConfiguredName, ...aliases].
 * Aliases are inspired by minimal-server/queueParser.js so older DBs still work.
 */
export function buildPropertyResolver(cfg: AppConfig) {
  const p = cfg.notion.property_names;
  const aliases: Record<keyof typeof p, string[]> = {
    Status: [p.Status, "OutReach Status", "out_reach_status", "outReachStatus", "Status", "status"],
    Action: [p.Action, "Action", "action"],
    Platform: [p.Platform, "Platform", "platform"],
    InNOut: [p.InNOut, "InNOut", "in_n_out", "inNOut"],
    sender_email: [p.sender_email, "FCAccount", "fc_account", "Account"],
    subject: [p.subject, "Outreach Subject", "outreach_subject", "Subject", "subject"],
    body: [p.body, "Outreach Body", "outreach_body", "Body", "body"],
    payload: [p.payload, "Payload", "payload"],
    completion_time: [p.completion_time, "Completion Time", "completion_time"],
    result_remark: [p.result_remark, "Result Remark", "result_remark"],
    reply_status: [p.reply_status, "Reply Status", "reply_status", "replyStatus"],
    reply_body: [p.reply_body, "Reply Body", "reply_body"],
    reply_email: [p.reply_email, "Reply Email", "reply_email"],
    last_reply_time: [p.last_reply_time, "Last Reply Time", "last_reply_time"],
    trigger_time: [p.trigger_time, "Trigger Time", "trigger_time", "triggerTime"],
    task_id: [p.task_id, "Task ID", "task_id", "taskId"],
    cc: [p.cc, "cc", "CC", "Cc"],
  };

  const dedupe = <T,>(arr: T[]): T[] => Array.from(new Set(arr));
  const aliasMap = Object.fromEntries(
    Object.entries(aliases).map(([k, v]) => [k, dedupe(v.filter(Boolean))]),
  ) as Record<keyof typeof p, string[]>;

  function pick(properties: Record<string, any> | undefined, key: keyof typeof p): any {
    return firstDefined(properties, aliasMap[key]);
  }

  return { pick, aliasMap };
}

/* ------------------------- Write helpers ------------------------- */

const RICH_TEXT_LIMIT = 1900;

export function notionRichText(content: string): { rich_text: Array<{ type: "text"; text: { content: string } }> } {
  const c = String(content ?? "");
  const truncated = c.length > RICH_TEXT_LIMIT ? `${c.slice(0, RICH_TEXT_LIMIT)}…` : c;
  return { rich_text: [{ type: "text", text: { content: truncated } }] };
}

export function notionTitle(content: string): { title: Array<{ type: "text"; text: { content: string } }> } {
  const c = String(content ?? "");
  const truncated = c.length > RICH_TEXT_LIMIT ? `${c.slice(0, RICH_TEXT_LIMIT)}…` : c;
  return { title: [{ type: "text", text: { content: truncated } }] };
}

export function notionSelect(name: string): { select: { name: string } } {
  return { select: { name: String(name) } };
}

export function notionStatus(name: string): { status: { name: string } } {
  return { status: { name: String(name) } };
}

export function notionDate(date: Date): { date: { start: string } } {
  return { date: { start: date.toISOString() } };
}

export function notionEmail(email: string): { email: string | null } {
  const e = String(email ?? "").trim().toLowerCase();
  return { email: e || null };
}

const ASIA_SHANGHAI = "Asia/Shanghai";

/**
 * Datetime expressed as Asia/Shanghai wall-clock time.
 *
 * Notion validation rule: if `time_zone` is provided, `start`/`end` must NOT
 * carry a UTC offset (no `+HH:MM` and no trailing `Z`). The value is treated
 * as local time within the given `time_zone`. Mixing them yields:
 *   "if time zone is explicitly provided, start and end can't have non-zero
 *    time offsets from UTC."
 */
export function notionDateTimeAsiaShanghai(date: Date): {
  date: { start: string; time_zone: string };
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ASIA_SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const g = (t: Intl.DateTimeFormatPartTypes): string => parts.find((x) => x.type === t)?.value ?? "00";
  const pad2 = (s: string): string => String(s).padStart(2, "0");
  // Naive ISO without offset; `time_zone` below disambiguates.
  const start = `${g("year")}-${pad2(g("month"))}-${pad2(g("day"))}T${pad2(g("hour"))}:${pad2(g("minute"))}:${pad2(g("second"))}.000`;
  return { date: { start, time_zone: ASIA_SHANGHAI } };
}

/** Pick `notionStatus` or `notionSelect` based on the current page's prop type. */
export function statusOrSelect(currentProp: any, name: string): unknown {
  const t = currentProp?.type;
  if (t === "status") return notionStatus(name);
  return notionSelect(name);
}

/** Normalize email: lowercase + strict regex extraction. */
export function normalizeEmail(input: string): string {
  const s = String(input ?? "").trim().toLowerCase();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : s;
}
