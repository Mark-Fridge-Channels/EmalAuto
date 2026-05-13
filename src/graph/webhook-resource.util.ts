/**
 * Parse `resource` strings from Graph change notifications.
 *
 * Examples:
 * - `Users('{guid}')/Messages('{id}')`
 * - `users/alice@contoso.com/mailFolders/inbox/messages('{id}')`
 */

export function parseUserKeyFromResource(resource: string): string | null {
  if (!resource) return null;
  let m = resource.match(/^users\('([^']+)'\)/i);
  if (m?.[1]) return m[1];
  m = resource.match(/^users\/([^/]+)\//i);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  m = resource.match(/^Users\/([0-9a-fA-F-]{36})\//i);
  if (m?.[1]) return m[1];
  return null;
}

/** Returns well-known folder segment (e.g. `inbox`) or `null` if not folder-scoped. */
export function parseFolderFromResource(resource: string): string | null {
  const m = resource.match(/mailFolders\/([^/]+)\/messages/i);
  if (!m?.[1]) return null;
  return m[1].replace(/^'|'$/g, "");
}
