import { loadConfig } from "../config/index.js";
import { queryDatabase } from "../notion/client.js";
import { readRichText, readSelectOrStatus } from "../notion/property-mapper.js";
import { readRelationPageIds } from "../notion/relation.js";
import type { ProductLine } from "./types.js";

export type IcpGroup = "A" | "B" | "A&B";

export interface CampaignClient {
  pageId: string;
  companyName: string;
  icpGroup: IcpGroup;
  emailDoNotContact: boolean;
  productLines: ProductLine[];
}

function productLinesForIcp(group: IcpGroup): ProductLine[] {
  if (group === "A") return ["DTC"];
  if (group === "B") return ["ASIN_Plus"];
  return ["DTC", "ASIN_Plus"];
}

function normId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * Collect Client page ids from SalesChannelDB where:
 *   Channel Type = DTC|Amazon AND ICP Verdict = ICP
 *
 * Why not ClientDB.`ICP Group` formula?
 * That formula depends on SalesChannel `ICP Status` / `ICP Qualified Channel Type`
 * (also formulas). Via MarkAPI those often evaluate empty/Unverified even when
 * the stable select `ICP Verdict` is already ICP. Orchestration therefore derives
 * A/B/A&B from Channel Type + ICP Verdict.
 */
async function collectIcpClientIdsByChannelType(
  salesChannelDbId: string,
  channelType: "DTC" | "Amazon",
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await queryDatabase(salesChannelDbId, {
      pageSize: 100,
      startCursor: cursor,
      filter: {
        and: [
          { property: "Channel Type", select: { equals: channelType } },
          { property: "ICP Verdict", select: { equals: "ICP" } },
        ],
      },
    });
    for (const r of page.results) {
      for (const clientId of readRelationPageIds(r.properties?.Client)) {
        ids.add(normId(clientId));
      }
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return ids;
}

function icpGroupFromSets(clientNormId: string, dtc: Set<string>, amazon: Set<string>): IcpGroup | null {
  const hasDtc = dtc.has(clientNormId);
  const hasAmazon = amazon.has(clientNormId);
  if (hasDtc && hasAmazon) return "A&B";
  if (hasDtc) return "A";
  if (hasAmazon) return "B";
  return null;
}

/**
 * Load campaign-eligible Clients by deriving ICP Group from SalesChannelDB,
 * then requiring Client `Has Verified Email` (formula checkbox) = true and
 * `Email Do Not Contact` = false.
 */
export async function listCampaignClients(opts?: {
  limit?: number;
  icpGroups?: IcpGroup[];
}): Promise<CampaignClient[]> {
  const cfg = loadConfig();
  const clientDbId = cfg.notion.campaign.client_database_id;
  const salesDbId = cfg.notion.campaign.sales_channel_database_id;
  if (!clientDbId) throw new Error("NOTION_CLIENT_DATABASE_ID is not configured");
  if (!salesDbId) throw new Error("NOTION_SALES_CHANNEL_DATABASE_ID is not configured");

  const want = new Set<IcpGroup>(opts?.icpGroups ?? ["A", "B", "A&B"]);

  const [dtcIds, amazonIds, verifiedById] = await Promise.all([
    collectIcpClientIdsByChannelType(salesDbId, "DTC"),
    collectIcpClientIdsByChannelType(salesDbId, "Amazon"),
    collectVerifiedSendableClients(clientDbId),
  ]);

  const allNormIds = new Set<string>([...dtcIds, ...amazonIds]);
  const out: CampaignClient[] = [];

  // Stable order for deterministic --limit
  const ordered = [...allNormIds].sort();

  for (const nid of ordered) {
    const meta = verifiedById.get(nid);
    if (!meta) continue;

    const group = icpGroupFromSets(nid, dtcIds, amazonIds);
    if (!group || !want.has(group)) continue;

    out.push({
      pageId: meta.pageId,
      companyName: meta.companyName,
      icpGroup: group,
      emailDoNotContact: false,
      productLines: productLinesForIcp(group),
    });

    if (opts?.limit && out.length >= opts.limit) break;
  }

  if (out.length === 0 && allNormIds.size === 0) {
    throw new Error(
      "No SalesChannel rows with ICP Verdict=ICP found. " +
        "Check NOTION_SALES_CHANNEL_DATABASE_ID sharing and ICP Verdict values.",
    );
  }

  return out;
}

interface VerifiedClientMeta {
  pageId: string;
  companyName: string;
}

/** ClientDB: Has Verified Email formula = true AND Email Do Not Contact = false. */
async function collectVerifiedSendableClients(
  clientDbId: string,
): Promise<Map<string, VerifiedClientMeta>> {
  const byId = new Map<string, VerifiedClientMeta>();
  let cursor: string | undefined;
  do {
    const page = await queryDatabase(clientDbId, {
      pageSize: 100,
      startCursor: cursor,
      filter: {
        and: [
          { property: "Has Verified Email", formula: { checkbox: { equals: true } } },
          { property: "Email Do Not Contact", checkbox: { equals: false } },
        ],
      },
    });
    for (const r of page.results) {
      const p = r.properties ?? {};
      byId.set(normId(r.id), {
        pageId: r.id,
        companyName: readRichText(p["Company Name"]) || readRichText(p.Name) || "",
      });
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return byId;
}

export function readSelectNameSafe(prop: unknown): string {
  return readSelectOrStatus(prop as never);
}
