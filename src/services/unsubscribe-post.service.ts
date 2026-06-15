/**
 * Parse RFC 8058 one-click POST body (urlencoded or multipart/form-data).
 */
export function parseOneClickUnsubscribeBody(
  contentType: string | undefined,
  raw: string,
): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    if (/List-Unsubscribe=One-Click/i.test(raw)) return true;
    try {
      const params = new URLSearchParams(raw);
      return params.get("List-Unsubscribe")?.trim().toLowerCase() === "one-click";
    } catch {
      return false;
    }
  }
  return false;
}

export function isOneClickUnsubscribeBody(body: unknown): boolean {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const v = (body as Record<string, unknown>)["List-Unsubscribe"];
    if (typeof v === "string" && v.trim().toLowerCase() === "one-click") return true;
  }
  return false;
}
