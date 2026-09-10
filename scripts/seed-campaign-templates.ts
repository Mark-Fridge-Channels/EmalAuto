/**
 * Idempotent seed of Christmas Pilot email templates into FC3.0-CampaignDB.
 *
 * Usage: npm run campaign:seed-templates
 */
import { CHRISTMAS_PILOT_EMAIL_TEMPLATES } from "../src/campaign/christmas-pilot-templates.js";
import { loadConfig, printConfigSummary } from "../src/config/index.js";
import { createPageInDatabase, queryDatabase, updatePage } from "../src/notion/client.js";
import {
  notionCheckbox,
  notionDateOnly,
  notionNumber,
  notionRichText,
  notionSelect,
  notionTitle,
  readSelectOrStatus,
} from "../src/notion/property-mapper.js";

function readNumber(prop: unknown): number | null {
  if (!prop || typeof prop !== "object") return null;
  const n = (prop as { number?: number | null }).number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function findExisting(
  databaseId: string,
  campaignKey: string,
  productLine: string,
  stepIndex: number,
): Promise<string | null> {
  const res = await queryDatabase(databaseId, {
    pageSize: 5,
    filter: {
      and: [
        { property: "Campaign Key", select: { equals: campaignKey } },
        { property: "Product Line", select: { equals: productLine } },
        { property: "Step Index", number: { equals: stepIndex } },
        { property: "Channel", select: { equals: "Email" } },
      ],
    },
  });
  return res.results[0]?.id ?? null;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  printConfigSummary(cfg);

  const databaseId = cfg.notion.campaign.campaign_database_id;
  if (!databaseId) {
    throw new Error("Set NOTION_CAMPAIGN_DATABASE_ID before seeding templates");
  }

  const campaignKey = cfg.notion.campaign.campaign_key;
  const windowStart = cfg.notion.campaign.window_start;
  const windowEnd = cfg.notion.campaign.window_end;
  const dailyCap = cfg.notion.campaign.daily_cap_per_mailbox;

  let created = 0;
  let updated = 0;

  for (const t of CHRISTMAS_PILOT_EMAIL_TEMPLATES) {
    const properties: Record<string, unknown> = {
      Name: notionTitle(t.name),
      "Campaign Key": notionSelect(campaignKey),
      "Product Line": notionSelect(t.productLine),
      "Step Index": notionNumber(t.stepIndex),
      Channel: notionSelect("Email"),
      "Subject Template": notionRichText(t.subjectTemplate),
      "Body Template": notionRichText(t.bodyTemplate),
      "Min Gap Business Days": notionNumber(1),
      "Window Start": notionDateOnly(windowStart),
      "Window End": notionDateOnly(windowEnd),
      "Daily Cap Per Mailbox": notionNumber(dailyCap),
      Active: notionCheckbox(true),
      Notes: notionRichText(`${campaignKey} ${t.productLine} step ${t.stepIndex}`),
    };

    const existingId = await findExisting(databaseId, campaignKey, t.productLine, t.stepIndex);
    if (existingId) {
      await updatePage(existingId, properties);
      updated += 1;
      console.log(`updated ${t.productLine}#${t.stepIndex} ${existingId}`);
    } else {
      const page = await createPageInDatabase(databaseId, properties);
      created += 1;
      console.log(`created ${t.productLine}#${t.stepIndex} ${page.id}`);
    }
  }

  // Sanity: list back
  const listed = await queryDatabase(databaseId, {
    pageSize: 100,
    filter: {
      and: [
        { property: "Campaign Key", select: { equals: campaignKey } },
        { property: "Channel", select: { equals: "Email" } },
        { property: "Active", checkbox: { equals: true } },
      ],
    },
  });

  const summary = listed.results.map((r) => {
    const p = r.properties ?? {};
    return `${readSelectOrStatus(p["Product Line"])}#${readNumber(p["Step Index"])}`;
  });

  console.log(JSON.stringify({ created, updated, activeEmailTemplates: summary.sort() }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
