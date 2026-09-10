import { loadConfig } from "../config/index.js";
import { getPage, type NotionPage } from "../notion/client.js";
import { readRichText, readSelectOrStatus } from "../notion/property-mapper.js";
import { readRelationPageId } from "../notion/relation.js";
import { renderTemplate, shouldUsePrefilledCopy } from "./template-render.js";
import type { CampaignSendBundle } from "./resolve-send.js";

export interface RenderedCampaignCopy {
  subject: string;
  body: string;
  usedTemplate: boolean;
  templatePageId?: string;
}

function signatureNameFromMailbox(email: string): string {
  const local = email.split("@")[0] ?? "FC";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Resolve final subject/body for a CampaignHistory row.
 * Both non-empty → use as-is; otherwise render both from Template relation.
 */
export async function resolveCampaignCopy(opts: {
  historyPage: NotionPage;
  subject: string;
  body: string;
  bundle: CampaignSendBundle;
  fromMailbox: string;
}): Promise<RenderedCampaignCopy> {
  if (shouldUsePrefilledCopy(opts.subject, opts.body)) {
    return { subject: opts.subject.trim(), body: opts.body.trim(), usedTemplate: false };
  }

  const props = opts.historyPage.properties as Record<string, unknown>;
  const templatePageId = readRelationPageId(props.Template);
  if (!templatePageId) {
    throw new Error("Subject/Body incomplete and Template relation is missing");
  }

  const tmpl = await getPage(templatePageId);
  const tp = tmpl.properties as Record<string, unknown>;
  const subjectTemplate = readRichText(tp["Subject Template"]);
  const bodyTemplate = readRichText(tp["Body Template"]);
  if (!subjectTemplate.trim() || !bodyTemplate.trim()) {
    throw new Error(`Template ${templatePageId} missing Subject Template or Body Template`);
  }

  const cfg = loadConfig();
  const vars: Record<string, string> = {
    "First Name": opts.bundle.firstName || "there",
    "Brand Name": opts.bundle.companyName || "your brand",
    "DTC Christmas Pilot Page": cfg.notion.campaign.dtc_pilot_page_url || "{{DTC Christmas Pilot Page}}",
    "ASIN Plus Christmas Pilot Page":
      cfg.notion.campaign.asin_pilot_page_url || "{{ASIN Plus Christmas Pilot Page}}",
    "Sender Name": signatureNameFromMailbox(opts.fromMailbox),
  };

  return {
    subject: renderTemplate(subjectTemplate, vars).trim(),
    body: renderTemplate(bodyTemplate, vars).trim(),
    usedTemplate: true,
    templatePageId,
  };
}

export function readHistoryProductLine(page: NotionPage): string {
  return readSelectOrStatus((page.properties as Record<string, unknown>)["Product Line"]);
}
