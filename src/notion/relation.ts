import { hyphenateId } from "./client.js";

/** First linked page id from a Notion `relation` property, or null. */
export function readRelationPageId(prop: unknown): string | null {
  const ids = readRelationPageIds(prop);
  return ids[0] ?? null;
}

/** All linked page ids from a Notion `relation` property. */
export function readRelationPageIds(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const o = prop as Record<string, unknown>;
  if (o.type !== "relation") return [];
  const arr = o.relation as Array<{ id?: string }> | undefined;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (item?.id) out.push(hyphenateId(String(item.id)));
  }
  return out;
}
