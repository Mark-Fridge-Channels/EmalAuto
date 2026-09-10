/**
 * Signed open-tracking tokens + HTML pixel injection.
 *
 * Open counts are heuristic (image load). Apple MPP / proxy prefetch inflate;
 * blocked images undercount. Treat as directional, not exact.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface OpenTrackTokenPayload {
  purpose: "open";
  recipientEmail: string;
  notionPageId: string;
  exp: number;
}

/** 1×1 transparent GIF. */
export const TRANSPARENT_GIF_BASE64 =
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export const TRANSPARENT_GIF_BYTES = Buffer.from(TRANSPARENT_GIF_BASE64, "base64");

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function base64UrlDecode(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

export function createOpenTrackToken(
  payload: Omit<OpenTrackTokenPayload, "exp" | "purpose"> & { exp?: number },
  secret: string,
  ttlSec: number,
): string {
  const full: OpenTrackTokenPayload = {
    purpose: "open",
    recipientEmail: payload.recipientEmail.trim().toLowerCase(),
    notionPageId: payload.notionPageId.trim(),
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + ttlSec,
  };
  const encoded = base64UrlEncode(JSON.stringify(full));
  const sig = signPayload(encoded, secret);
  return `${encoded}.${sig}`;
}

export function verifyOpenTrackToken(
  token: string,
  secret: string,
): { ok: true; payload: OpenTrackTokenPayload } | { ok: false; reason: string } {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed token" };

  const [encoded, sig] = parts;
  if (!encoded || !sig) return { ok: false, reason: "malformed token" };

  const expected = signPayload(encoded, secret);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid signature" };
  }

  let payload: OpenTrackTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as OpenTrackTokenPayload;
  } catch {
    return { ok: false, reason: "invalid payload" };
  }

  if (payload.purpose !== "open") return { ok: false, reason: "wrong purpose" };
  if (!payload.recipientEmail || !payload.notionPageId || !payload.exp) {
    return { ok: false, reason: "missing fields" };
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "token expired" };
  }

  return {
    ok: true,
    payload: {
      purpose: "open",
      recipientEmail: payload.recipientEmail.trim().toLowerCase(),
      notionPageId: payload.notionPageId.trim(),
      exp: payload.exp,
    },
  };
}

export function buildOpenPixelUrl(params: {
  publicBaseUrl: string;
  openPath: string;
  token: string;
}): string {
  const base = params.publicBaseUrl.replace(/\/$/, "");
  const path = params.openPath.startsWith("/") ? params.openPath : `/${params.openPath}`;
  return `${base}${path}/${encodeURIComponent(params.token)}.gif`;
}

export function buildOpenPixelImgTag(pixelUrl: string): string {
  const url = pixelUrl.trim();
  return `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden;" />`;
}

/** Insert open pixel before </body>, else append. Idempotent if URL already present. */
export function injectOpenPixel(html: string, pixelUrl: string): string {
  const url = pixelUrl.trim();
  if (!url || !html) return html;
  if (html.includes(url)) return html;
  const tag = buildOpenPixelImgTag(url);
  const bodyClose = html.match(/<\/body>/i);
  if (bodyClose && bodyClose.index != null) {
    return `${html.slice(0, bodyClose.index)}${tag}${html.slice(bodyClose.index)}`;
  }
  return `${html}${tag}`;
}

export function canIssueOpenTracking(params: {
  enabled: boolean;
  publicBaseUrl: string;
  secret: string;
}): boolean {
  if (!params.enabled) return false;
  if (!params.publicBaseUrl.trim().toLowerCase().startsWith("https://")) return false;
  return params.secret.trim().length >= 8;
}

/** Hash client IP for light analytics without storing raw address. */
export function hashClientIp(ip: string | undefined, secret: string): string | null {
  const v = (ip ?? "").trim();
  if (!v) return null;
  return createHash("sha256").update(`${secret}:${v}`, "utf8").digest("hex").slice(0, 32);
}
