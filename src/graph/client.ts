/**
 * Microsoft Graph HTTP client.
 *
 * We deliberately call the Graph REST API directly (instead of the SDK) so we
 * can: pin behavior, attach our own logger/retry, and avoid the SDK's
 * AuthProvider interface gymnastics. App-only token comes from auth/msal.
 */

import { acquireGraphTokenForMailbox } from "../auth/msal.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

interface GraphFetchOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  /**
   * The mailbox whose tenant App should authorize this request. With
   * per-domain Apps every Graph call MUST declare its actor so we can
   * pick the right token.
   */
  actorMailbox: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Internal: do not set externally. */
  attempt?: number;
  /** If true, return the raw fetch Response (caller reads body). */
  raw?: boolean;
  /** When the endpoint returns no body (e.g. 202 sendMail). */
  expectEmpty?: boolean;
}

function buildUrl(path: string, query?: GraphFetchOptions["query"]): string {
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function graphFetch<T = unknown>(opts: GraphFetchOptions): Promise<T> {
  const { method, path, actorMailbox, body, query, attempt = 0, expectEmpty = false } = opts;
  const token = await acquireGraphTokenForMailbox(actorMailbox);
  const url = buildUrl(path, query);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && attempt === 0) {
    // Force token refresh once on first 401, then retry.
    await acquireGraphTokenForMailbox(actorMailbox, { force: true });
    return graphFetch<T>({ ...opts, attempt: attempt + 1 });
  }

  if (res.status === 429 || res.status === 503) {
    if (attempt < 5) {
      const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(16_000, 500 * 2 ** attempt);
      logger.warn({ path, status: res.status, attempt, backoff }, "graph throttled, backing off");
      await sleep(backoff);
      return graphFetch<T>({ ...opts, attempt: attempt + 1 });
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const code = parsed?.error?.code ?? "";
    const msg = parsed?.error?.message ?? `Graph error: HTTP ${res.status}`;
    throw new GraphApiError(`[${code || res.status}] ${msg}`, res.status, code, parsed);
  }

  if (expectEmpty || res.status === 202 || res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Follow absolute Graph URLs returned by delta / pagination (`@odata.nextLink`).
 * Same auth + retry semantics as `graphFetch`. `actorMailbox` decides which
 * App's token authorizes the call.
 */
export async function graphFetchAbsolute<T = unknown>(
  absoluteUrl: string,
  opts: {
    actorMailbox: string;
    method?: "GET" | "POST";
    body?: unknown;
    attempt?: number;
  },
): Promise<T> {
  const method = opts.method ?? "GET";
  const body = opts.body;
  const attempt = opts.attempt ?? 0;
  const token = await acquireGraphTokenForMailbox(opts.actorMailbox);

  const res = await fetch(absoluteUrl, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && attempt === 0) {
    await acquireGraphTokenForMailbox(opts.actorMailbox, { force: true });
    return graphFetchAbsolute<T>(absoluteUrl, { ...opts, attempt: attempt + 1 });
  }

  if (res.status === 429 || res.status === 503) {
    if (attempt < 5) {
      const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(16_000, 500 * 2 ** attempt);
      logger.warn({ absoluteUrl: absoluteUrl.slice(0, 120), status: res.status, attempt, backoff }, "graph absolute throttled");
      await sleep(backoff);
      return graphFetchAbsolute<T>(absoluteUrl, { ...opts, attempt: attempt + 1 });
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const code = parsed?.error?.code ?? "";
    const msg = parsed?.error?.message ?? `Graph error: HTTP ${res.status}`;
    throw new GraphApiError(`[${code || res.status}] ${msg}`, res.status, code, parsed);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Binary body (e.g. attachment `$value`). */
export async function graphFetchBinary(opts: {
  path: string;
  actorMailbox: string;
  attempt?: number;
}): Promise<Buffer> {
  const { path, actorMailbox, attempt = 0 } = opts;
  const token = await acquireGraphTokenForMailbox(actorMailbox);
  const url = buildUrl(path, undefined);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && attempt === 0) {
    await acquireGraphTokenForMailbox(actorMailbox, { force: true });
    return graphFetchBinary({ ...opts, attempt: attempt + 1 });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GraphApiError(`Graph binary error: HTTP ${res.status}`, res.status, "", text);
  }

  return Buffer.from(await res.arrayBuffer());
}
