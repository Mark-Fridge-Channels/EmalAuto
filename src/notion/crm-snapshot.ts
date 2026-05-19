/**
 * CRM fields from Notion → Postgres (`outbound_messages` / `inbox_messages`).
 *
 * Primary path: Interaction LOG **DTC Entity** / **DTC Key Person** relations.
 * Legacy fallback: flat columns on the IL row (`NOTION_COL_KEYPERSON_*`, etc.).
 */

import type { AppConfig } from "../config/index.js";
import type { OutboundMessage } from "../db/schema/outbound_messages.js";
import { getPage, hyphenateId, type NotionPage } from "./client.js";
import { readFormulaText, readRichText } from "./property-mapper.js";
import { readRelationPageId } from "./relation.js";

function readPlain(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const o = prop as Record<string, unknown>;
  const t = o.type;
  if (t === "title") {
    const arr = o.title as Array<{ plain_text?: string }> | undefined;
    return (arr?.map((x) => x.plain_text).join("") ?? "").trim();
  }
  if (t === "rich_text") {
    const arr = o.rich_text as Array<{ plain_text?: string }> | undefined;
    return (arr?.map((x) => x.plain_text).join("") ?? "").trim();
  }
  if (t === "url") return String(o.url ?? "").trim();
  if (t === "email") return String(o.email ?? "").trim();
  if (t === "unique_id") {
    const u = o.unique_id as { prefix?: string; number?: number } | undefined;
    if (u?.prefix != null && u.number != null) return `${u.prefix}-${u.number}`;
    return "";
  }
  if (t === "select") return String((o.select as { name?: string } | null)?.name ?? "").trim();
  if (t === "status") return String((o.status as { name?: string } | null)?.name ?? "").trim();
  return "";
}

function readPlainFlexible(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const o = prop as Record<string, unknown>;
  const t = o.type;
  if (t === "title" || t === "rich_text") return readRichText(o as never);
  if (t === "formula") return readFormulaText(o as never);
  if (t === "url") return String(o.url ?? "").trim();
  if (t === "email") return String(o.email ?? "").trim();
  if (t === "unique_id") {
    const u = o.unique_id as { prefix?: string; number?: number } | undefined;
    if (u?.prefix != null && u.number != null) return `${u.prefix}-${u.number}`;
    return "";
  }
  if (t === "select") return String((o.select as { name?: string } | null)?.name ?? "").trim();
  if (t === "status") return String((o.status as { name?: string } | null)?.name ?? "").trim();
  return readPlain(prop);
}

function readTitleFromPage(properties: Record<string, unknown>): string {
  for (const p of Object.values(properties)) {
    if (p && typeof p === "object" && (p as { type?: string }).type === "title") {
      return readRichText(p as never);
    }
  }
  return "";
}

export function notionPagePublicUrl(pageId: string): string {
  const compact = String(pageId ?? "").replace(/-/g, "").toLowerCase();
  return compact.length === 32 ? `https://www.notion.so/${compact}` : "";
}

/** Parse `https://www.notion.so/<32hex>` (or hyphenated) → canonical page id. */
export function notionUrlToPageId(url: string | null | undefined): string | null {
  const s = String(url ?? "").trim();
  if (!s) return null;
  const compact = s.replace(/.*\//, "").replace(/-/g, "").toLowerCase();
  const hex = compact.length >= 32 ? compact.slice(-32) : compact;
  if (!/^[a-f0-9]{32}$/.test(hex)) return null;
  return hyphenateId(hex);
}

/** Copy CRM columns from a matched `outbound_messages` row. */
export function crmSnapshotFromOutbound(ob: OutboundMessage | null | undefined): CrmSnapshot {
  if (!ob) return { ...EMPTY_CRM };
  const nz = (v: string | null | undefined) => (v != null && String(v).trim() !== "" ? String(v).trim() : null);
  return {
    keyPersonId: nz(ob.keyPersonId),
    keyPersonName: nz(ob.keyPersonName),
    keyPersonNotionUrl: nz(ob.keyPersonNotionUrl),
    entityName: nz(ob.entityName),
    entityNotionUrl: nz(ob.entityNotionUrl),
  };
}

export interface CrmSnapshot {
  keyPersonId: string | null;
  keyPersonName: string | null;
  keyPersonNotionUrl: string | null;
  entityName: string | null;
  entityNotionUrl: string | null;
}

const EMPTY_CRM: CrmSnapshot = {
  keyPersonId: null,
  keyPersonName: null,
  keyPersonNotionUrl: null,
  entityName: null,
  entityNotionUrl: null,
};

function hasCrmData(crm: CrmSnapshot): boolean {
  return Boolean(
    crm.keyPersonId ||
      crm.keyPersonName ||
      crm.keyPersonNotionUrl ||
      crm.entityName ||
      crm.entityNotionUrl,
  );
}

/** Legacy: read CRM-shaped columns directly on the Interaction LOG row. */
export function extractCrmFromNotionProperties(
  cfg: AppConfig,
  properties: Record<string, unknown>,
): CrmSnapshot {
  const c = cfg.notion.crm_columns;
  const pick = (col: string) => (col.trim() ? readPlain(properties[col]) : "");

  const keyId = c.key_person_id.trim() ? pick(c.key_person_id) : "";
  const keyName = c.key_person_name.trim() ? pick(c.key_person_name) : "";
  const keyUrl = c.key_person_url.trim() ? pick(c.key_person_url) : "";
  const entName = c.entity_name.trim() ? pick(c.entity_name) : "";
  const entUrl = c.entity_url.trim() ? pick(c.entity_url) : "";

  return {
    keyPersonId: keyId || null,
    keyPersonName: keyName || null,
    keyPersonNotionUrl: keyUrl || null,
    entityName: entName || null,
    entityNotionUrl: entUrl || null,
  };
}

function crmFromKeyPersonPage(kpPage: NotionPage, cfg: AppConfig): Partial<CrmSnapshot> {
  const sync = cfg.notion.dtc.sync_columns;
  const kpProps = kpPage.properties as Record<string, unknown>;
  const title = readTitleFromPage(kpProps);
  let kpId = sync.kp_id_prop.trim() ? readPlainFlexible(kpProps[sync.kp_id_prop]) : "";
  if (!kpId) {
    for (const p of Object.values(kpProps)) {
      if (p && typeof p === "object" && (p as { type?: string }).type === "unique_id") {
        kpId = readPlainFlexible(p);
        if (kpId) break;
      }
    }
  }
  if (!kpId) kpId = title;
  const kpName = sync.kp_name_prop.trim()
    ? readPlainFlexible(kpProps[sync.kp_name_prop])
    : title || kpId;
  const kpUrl = notionPagePublicUrl(kpPage.id);
  return {
    keyPersonId: kpId || null,
    keyPersonName: kpName || null,
    keyPersonNotionUrl: kpUrl || null,
  };
}

function crmFromEntityPage(entPage: NotionPage, cfg: AppConfig): Partial<CrmSnapshot> {
  const sync = cfg.notion.dtc.sync_columns;
  const entProps = entPage.properties as Record<string, unknown>;
  const title = readTitleFromPage(entProps);
  const name = sync.entity_name_prop.trim()
    ? readPlainFlexible(entProps[sync.entity_name_prop])
    : title;
  const entUrl = notionPagePublicUrl(entPage.id);
  return {
    entityName: name || null,
    entityNotionUrl: entUrl || null,
  };
}

/** Resolve CRM from DTC Key Person / Entity Notion page ids. */
export async function extractCrmFromDtcPageIds(
  cfg: AppConfig,
  opts: { keyPersonPageId?: string | null; entityPageId?: string | null },
): Promise<CrmSnapshot> {
  const out: CrmSnapshot = { ...EMPTY_CRM };
  const kpId = opts.keyPersonPageId?.trim();
  const entId = opts.entityPageId?.trim();

  if (kpId) {
    const kpPage = await getPage(hyphenateId(kpId));
    Object.assign(out, crmFromKeyPersonPage(kpPage, cfg));
  }
  if (entId) {
    const entPage = await getPage(hyphenateId(entId));
    Object.assign(out, crmFromEntityPage(entPage, cfg));
  }
  return out;
}

/**
 * Interaction LOG row → CRM via **DTC Entity** / **DTC Key Person** relations;
 * falls back to legacy IL columns when relations are empty.
 */
export async function extractCrmFromInteractionLogPage(
  ilPage: NotionPage,
  cfg: AppConfig,
): Promise<CrmSnapshot> {
  const d = cfg.notion.dtc;
  const props = ilPage.properties as Record<string, unknown>;
  const entityPageId = readRelationPageId(props[d.il_columns.dtc_entity]);
  const keyPersonPageId = readRelationPageId(props[d.il_columns.dtc_key_person]);

  if (entityPageId || keyPersonPageId) {
    const fromDtc = await extractCrmFromDtcPageIds(cfg, { entityPageId, keyPersonPageId });
    if (hasCrmData(fromDtc)) return fromDtc;
  }

  return extractCrmFromNotionProperties(cfg, props);
}
