/**
 * Notion HTTP client.
 *
 * Implements the same shape as minimal-server/notion.js (no SDK), so we keep:
 * - 429 with Retry-After + exponential backoff
 * - global serialization (≈3 req/s rate cap)
 * - hyphenation of 32-char IDs
 *
 * Returns raw JSON; semantic parsing lives in property-mapper.ts and writer.ts.
 */

import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";

const NOTION_BASE = "https://api.notion.com/v1";

/** Hard-cap requests/sec to stay under Notion's ~3 rps limit. */
const MIN_GAP_MS = 350;
let lastSendAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize all calls; minimal-server effectively does this implicitly. */
function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const elapsed = Date.now() - lastSendAt;
    if (elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed);
    try {
      return await fn();
    } finally {
      lastSendAt = Date.now();
    }
  });
  // Don't let one failure kill the chain.
  queue = next.catch(() => undefined);
  return next;
}

/** "32-char hex" => "8-4-4-4-12" hyphenated. Pass-through if already hyphenated. */
export function hyphenateId(id: string): string {
  const cleaned = String(id || "").replace(/-/g, "");
  if (cleaned.length !== 32) return String(id);
  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

interface NotionFetchOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  attempt?: number;
}

async function notionFetch<T>(opts: NotionFetchOptions): Promise<T> {
  const cfg = loadConfig();
  const { method, path, body, attempt = 0 } = opts;
  const url = `${NOTION_BASE}${path}`;

  return withRateLimit(async () => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.notion.token}`,
        "Notion-Version": cfg.notion.notion_version,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      // 429: respect Retry-After or exponential backoff up to 5 attempts.
      if (res.status === 429 && attempt < 5) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** attempt);
        logger.warn({ path, attempt, backoff }, "notion 429, backing off");
        await sleep(backoff);
        return notionFetch<T>({ ...opts, attempt: attempt + 1 });
      }
      const code = data?.code != null ? String(data.code) : "";
      const msg = data?.message ?? data?.error ?? `Notion API error: HTTP ${res.status}`;
      throw new NotionApiError(code ? `[${code}] ${msg}` : msg, res.status, code, data);
    }
    return data as T;
  });
}

/* -------------------------- Public surface -------------------------- */

export interface QueryDatabaseOptions {
  pageSize?: number;
  filter?: unknown;
  sorts?: unknown[];
  startCursor?: string;
}

export interface NotionPage {
  id: string;
  properties: Record<string, any>;
  url?: string;
  archived?: boolean;
  [k: string]: unknown;
}

export interface QueryResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

export async function queryDatabase(
  databaseId: string,
  opts: QueryDatabaseOptions = {},
): Promise<QueryResult> {
  const body: Record<string, unknown> = { page_size: opts.pageSize ?? 20 };
  if (opts.filter) body.filter = opts.filter;
  if (opts.sorts?.length) body.sorts = opts.sorts;
  if (opts.startCursor) body.start_cursor = opts.startCursor;
  return notionFetch<QueryResult>({
    method: "POST",
    path: `/databases/${hyphenateId(databaseId)}/query`,
    body,
  });
}

export async function getPage(pageId: string): Promise<NotionPage> {
  return notionFetch<NotionPage>({ method: "GET", path: `/pages/${hyphenateId(pageId)}` });
}

export async function updatePage(
  pageId: string,
  properties: Record<string, unknown>,
): Promise<NotionPage> {
  return notionFetch<NotionPage>({
    method: "PATCH",
    path: `/pages/${hyphenateId(pageId)}`,
    body: { properties },
  });
}

export async function retrieveDatabase(databaseId: string): Promise<{
  id: string;
  properties: Record<string, { type: string; [k: string]: unknown }>;
}> {
  return notionFetch({
    method: "GET",
    path: `/databases/${hyphenateId(databaseId)}`,
  });
}

/**
 * Create a page (row) inside the configured Notion database.
 *
 * `properties` should already be in Notion API write-format (e.g. `{title: [...]}`,
 * `{select: { name }}`, `{date: { start }}`, `{rich_text: [...]}`, etc).
 * The caller MUST include a value for the database's title property.
 */
export async function createPageInDatabase(
  databaseId: string,
  properties: Record<string, unknown>,
): Promise<NotionPage> {
  return notionFetch<NotionPage>({
    method: "POST",
    path: `/pages`,
    body: {
      parent: { database_id: hyphenateId(databaseId) },
      properties,
    },
  });
}
