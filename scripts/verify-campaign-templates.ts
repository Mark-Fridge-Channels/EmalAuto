/**
 * Verify Campaign DB templates are readable via ntn token.
 *
 * Usage: npm run campaign:verify-templates
 */
import { listCampaignTemplates } from "../src/campaign/templates.js";
import { renderTemplate } from "../src/campaign/template-render.js";
import { loadConfig, printConfigSummary } from "../src/config/index.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  printConfigSummary(cfg);

  if (!cfg.notion.campaign.campaign_database_id) {
    throw new Error("NOTION_CAMPAIGN_DATABASE_ID is empty");
  }
  if (!cfg.notion.campaign.history_database_id) {
    console.warn("WARN: NOTION_CAMPAIGN_HISTORY_DATABASE_ID is empty (ok for template-only check)");
  }

  const rows = await listCampaignTemplates({ activeOnly: true, channel: "Email" });
  console.log(`loaded ${rows.length} active email templates`);
  for (const r of rows) {
    const sampleSubject = renderTemplate(r.subjectTemplate, {
      "First Name": "Alex",
      "Brand Name": "Sample Brand",
      "DTC Christmas Pilot Page": "https://example.com/dtc",
      "ASIN Plus Christmas Pilot Page": "https://example.com/asin",
      "Sender Name": "FC BD",
    });
    console.log(
      `- ${r.productLine} step ${r.stepIndex}: ${r.name} | subject≈${JSON.stringify(sampleSubject)} | bodyChars=${r.bodyTemplate.length} | ${r.pageId}`,
    );
  }

  const dtc = rows.filter((r) => r.productLine === "DTC").length;
  const asin = rows.filter((r) => r.productLine === "ASIN_Plus").length;
  if (dtc !== 4 || asin !== 5) {
    throw new Error(`expected DTC=4 ASIN_Plus=5, got DTC=${dtc} ASIN_Plus=${asin}`);
  }
  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
