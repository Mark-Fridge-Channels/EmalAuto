/**
 * RFC 8058 one-click unsubscribe: signed tokens + List-Unsubscribe headers.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribeTokenPayload {
  recipientEmail: string;
  notionPageId: string;
  exp: number;
}

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

export function createUnsubscribeToken(
  payload: Omit<UnsubscribeTokenPayload, "exp"> & { exp?: number },
  secret: string,
  ttlSec: number,
): string {
  const full: UnsubscribeTokenPayload = {
    recipientEmail: payload.recipientEmail.trim().toLowerCase(),
    notionPageId: payload.notionPageId.trim(),
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + ttlSec,
  };
  const encoded = base64UrlEncode(JSON.stringify(full));
  const sig = signPayload(encoded, secret);
  return `${encoded}.${sig}`;
}

export function verifyUnsubscribeToken(
  token: string,
  secret: string,
): { ok: true; payload: UnsubscribeTokenPayload } | { ok: false; reason: string } {
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

  let payload: UnsubscribeTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as UnsubscribeTokenPayload;
  } catch {
    return { ok: false, reason: "invalid payload" };
  }

  if (!payload.recipientEmail || !payload.notionPageId || !payload.exp) {
    return { ok: false, reason: "missing fields" };
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "token expired" };
  }

  return {
    ok: true,
    payload: {
      recipientEmail: payload.recipientEmail.trim().toLowerCase(),
      notionPageId: payload.notionPageId.trim(),
      exp: payload.exp,
    },
  };
}

export function buildUnsubscribeUrl(params: {
  publicBaseUrl: string;
  unsubscribePath: string;
  token: string;
}): string {
  const base = params.publicBaseUrl.replace(/\/$/, "");
  const path = params.unsubscribePath.startsWith("/")
    ? params.unsubscribePath
    : `/${params.unsubscribePath}`;
  return `${base}${path}/${encodeURIComponent(params.token)}`;
}

/** RFC 8058 headers for Graph `internetMessageHeaders`. */
export function buildListUnsubscribeHeaders(params: {
  publicBaseUrl: string;
  unsubscribePath: string;
  token: string;
}): Array<{ name: string; value: string }> {
  const url = buildUnsubscribeUrl(params);
  return [
    { name: "List-Unsubscribe", value: `<${url}>` },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ];
}

export function canIssueListUnsubscribeHeaders(publicBaseUrl: string): boolean {
  return publicBaseUrl.trim().toLowerCase().startsWith("https://");
}
