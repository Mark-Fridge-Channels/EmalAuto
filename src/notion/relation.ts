import { hyphenateId } from "./client.js";

/** First linked page id from a Notion `relation` property, or null. */
export function readRelationPageId(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const o = prop as Record<string, unknown>;
  if (o.type !== "relation") return null;
  const arr = o.relation as Array<{ id?: string }> | undefined;
  const id = arr?.[0]?.id;
  return id ? hyphenateId(String(id)) : null;
}
