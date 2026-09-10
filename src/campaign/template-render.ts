/**
 * Mustache-lite: replace {{Var Name}} tokens. Unknown tokens left intact.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return String(template ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, rawKey: string) => {
    const key = String(rawKey).trim();
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key] ?? "";
    return full;
  });
}

/** Both subject and body must be non-empty to skip template render (Phase 0 rule). */
export function shouldUsePrefilledCopy(subject: string | null | undefined, body: string | null | undefined): boolean {
  return Boolean(String(subject ?? "").trim()) && Boolean(String(body ?? "").trim());
}
