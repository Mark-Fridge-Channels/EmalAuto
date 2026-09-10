import { loadConfig } from "../config/index.js";
import { queryDatabase, type NotionPage } from "../notion/client.js";
import { readDateStart, readRichText, readSelectOrStatus } from "../notion/property-mapper.js";
import type { CampaignChannel, CampaignTemplateRow, ProductLine } from "./types.js";

function readNumber(prop: unknown): number | null {
  if (!prop || typeof prop !== "object") return null;
  const n = (prop as { number?: number | null }).number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function readCheckbox(prop: unknown): boolean {
  if (!prop || typeof prop !== "object") return false;
  return Boolean((prop as { checkbox?: boolean }).checkbox);
}

function mapTemplatePage(page: NotionPage): CampaignTemplateRow | null {
  const p = page.properties ?? {};
  const productLine = readSelectOrStatus(p["Product Line"]) as ProductLine | "";
  const stepIndex = readNumber(p["Step Index"]);
  const channel = (readSelectOrStatus(p.Channel) || "Email") as CampaignChannel;
  if (productLine !== "DTC" && productLine !== "ASIN_Plus") return null;
  if (stepIndex == null || stepIndex < 1) return null;

  const windowStartRaw = readDateStart(p["Window Start"]);
  const windowEndRaw = readDateStart(p["Window End"]);

  return {
    pageId: page.id,
    url: typeof page.url === "string" ? page.url : undefined,
    name: readRichText(p.Name) || readRichText(p.title) || "",
    campaignKey: readSelectOrStatus(p["Campaign Key"]) || "",
    productLine,
    stepIndex,
    channel,
    subjectTemplate: readRichText(p["Subject Template"]),
    bodyTemplate: readRichText(p["Body Template"]),
    minGapBusinessDays: readNumber(p["Min Gap Business Days"]) ?? 1,
    windowStart: windowStartRaw ? windowStartRaw.slice(0, 10) : null,
    windowEnd: windowEndRaw ? windowEndRaw.slice(0, 10) : null,
    dailyCapPerMailbox: readNumber(p["Daily Cap Per Mailbox"]),
    active: readCheckbox(p.Active),
  };
}

export async function listCampaignTemplates(opts?: {
  campaignKey?: string;
  activeOnly?: boolean;
  channel?: CampaignChannel;
}): Promise<CampaignTemplateRow[]> {
  const cfg = loadConfig();
  const databaseId = cfg.notion.campaign.campaign_database_id;
  if (!databaseId) throw new Error("NOTION_CAMPAIGN_DATABASE_ID is not configured");

  const campaignKey = opts?.campaignKey ?? cfg.notion.campaign.campaign_key;
  const activeOnly = opts?.activeOnly !== false;
  const channel = opts?.channel ?? "Email";

  const rows: CampaignTemplateRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryDatabase(databaseId, {
      pageSize: 100,
      startCursor: cursor,
      filter: {
        and: [
          { property: "Campaign Key", select: { equals: campaignKey } },
          ...(channel ? [{ property: "Channel", select: { equals: channel } }] : []),
          ...(activeOnly ? [{ property: "Active", checkbox: { equals: true } }] : []),
        ],
      },
      sorts: [
        { property: "Product Line", direction: "ascending" },
        { property: "Step Index", direction: "ascending" },
      ],
    });
    for (const r of page.results) {
      const mapped = mapTemplatePage(r);
      if (mapped) rows.push(mapped);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);

  return rows;
}

export async function getTemplateForStep(
  productLine: ProductLine,
  stepIndex: number,
  opts?: { campaignKey?: string },
): Promise<CampaignTemplateRow | null> {
  const all = await listCampaignTemplates({
    campaignKey: opts?.campaignKey,
    activeOnly: true,
    channel: "Email",
  });
  return all.find((t) => t.productLine === productLine && t.stepIndex === stepIndex) ?? null;
}
