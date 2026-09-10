import { loadConfig } from "../config/index.js";
import { getPage, queryDatabase } from "../notion/client.js";
import { readEmail, readRichText, readSelectOrStatus } from "../notion/property-mapper.js";
import { readRelationPageIds } from "../notion/relation.js";
import { buildKpList, type KpCandidateInput, type RankedKp } from "./kp-rank.js";
import type { ProductLine } from "./types.js";

function readNumber(prop: unknown): number | null {
  if (!prop || typeof prop !== "object") return null;
  const n = (prop as { number?: number | null }).number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function mapKpPage(page: { id: string; properties?: Record<string, unknown> }): KpCandidateInput {
  const p = page.properties ?? {};
  return {
    pageId: page.id,
    name: readRichText(p.name) || readRichText(p.Name) || "",
    email: readEmail(p.Email) || readRichText(p.Email),
    emailVerifiedStatus: readSelectOrStatus(p["Email Verified Status"]),
    contactRole: readSelectOrStatus(p["Contact Role"]),
    title: readRichText(p.Title),
    confidence: readSelectOrStatus(p.Confidence),
    currentEmploymentConfirmed: readSelectOrStatus(p["Current Employment Confirmed"]),
    contactPriority: readSelectOrStatus(p["Contact Priority"]),
    fitScore: readNumber(p["Fit Score"]),
  };
}

/** Load Key Persons linked to a Client (via KP.Client relation). */
export async function listKeyPersonsForClient(clientPageId: string): Promise<KpCandidateInput[]> {
  const cfg = loadConfig();
  const databaseId = cfg.notion.campaign.key_person_database_id;
  if (!databaseId) throw new Error("NOTION_KEYPERSON_DATABASE_ID is not configured");

  const out: KpCandidateInput[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryDatabase(databaseId, {
      pageSize: 100,
      startCursor: cursor,
      filter: {
        property: "Client",
        relation: { contains: clientPageId },
      },
    });
    for (const r of page.results) out.push(mapKpPage(r));
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);

  // Fallback: if Client page has Key Person relation and query returned empty, hydrate those pages
  if (out.length === 0) {
    try {
      const client = await getPage(clientPageId);
      const ids = readRelationPageIds(client.properties?.["Key Person"]);
      for (const id of ids) {
        const kp = await getPage(id);
        out.push(mapKpPage(kp));
      }
    } catch {
      // Client page may be unshared; ignore fallback
    }
  }

  return out;
}

export async function buildFrozenKpListForClient(
  clientPageId: string,
  productLine: ProductLine,
): Promise<RankedKp[]> {
  const candidates = await listKeyPersonsForClient(clientPageId);
  return buildKpList(candidates, productLine);
}
