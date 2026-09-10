import { listSendableMailboxes } from "../db/repositories/mailbox.repo.js";
import { loadConfig } from "../config/index.js";
import { listCampaignClients, type IcpGroup } from "./clients.js";
import { writeScheduledHistory, summarizeScheduleForLog } from "./history-writer.js";
import { buildFrozenKpListForClient } from "./key-persons.js";
import {
  buildInstanceKey,
  defaultStepCount,
  scheduleInstances,
  type CampaignInstanceInput,
  type ScheduleReport,
} from "./scheduler.js";
import { listCampaignTemplates } from "./templates.js";
import type { ProductLine } from "./types.js";

export interface OrchestrateOptions {
  dryRun?: boolean;
  /** First full write: create pages without Task-ID lookup. */
  freshWrite?: boolean;
  limitClients?: number;
  icpGroups?: IcpGroup[];
  /** If set, only these client page ids (hyphenated or not). */
  clientIds?: string[];
}

export interface OrchestrateResult {
  report: ScheduleReport;
  writeSummary: {
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
  sample: Array<Record<string, unknown>>;
  mailboxCount: number;
  clientCount: number;
  instanceCount: number;
}

function normId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export async function orchestrateChristmasPilot(opts: OrchestrateOptions = {}): Promise<OrchestrateResult> {
  const cfg = loadConfig();
  const campaignKey = cfg.notion.campaign.campaign_key;
  const windowStart = cfg.notion.campaign.window_start;
  const windowEnd = cfg.notion.campaign.window_end;
  const dailyCap = cfg.notion.campaign.daily_cap_per_mailbox;

  const templates = await listCampaignTemplates({ campaignKey, activeOnly: true, channel: "Email" });
  if (templates.length < 9) {
    throw new Error(`expected >=9 active email templates, got ${templates.length}`);
  }

  const mailboxes = await listSendableMailboxes();
  const mailboxEmails = mailboxes.map((m) => m.email).filter(Boolean);
  if (mailboxEmails.length === 0) throw new Error("no sendable mailboxes in Postgres");

  let clients;
  try {
    console.log("[orchestrate] loading campaign clients (SalesChannel + verified email)…");
    clients = await listCampaignClients({
      limit: opts.limitClients,
      icpGroups: opts.icpGroups,
    });
    console.log(`[orchestrate] loaded ${clients.length} clients`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("object_not_found") || msg.includes("Could not find database")) {
      throw new Error(
        `Cannot read ClientDB (${cfg.notion.campaign.client_database_id}). ` +
          `Share FC2.0-ClientDB with Notion integration MarkAPI, then retry. Underlying: ${msg}`,
      );
    }
    throw e;
  }
  if (opts.clientIds?.length) {
    const allow = new Set(opts.clientIds.map(normId));
    clients = clients.filter((c) => allow.has(normId(c.pageId)));
  }

  const instances: CampaignInstanceInput[] = [];
  let skippedNoKp = 0;
  let kpLookups = 0;
  const kpLookupTotal = clients.reduce((n, c) => n + c.productLines.length, 0);
  const t0 = Date.now();

  for (const client of clients) {
    for (const productLine of client.productLines) {
      kpLookups += 1;
      if (kpLookups === 1 || kpLookups % 50 === 0 || kpLookups === kpLookupTotal) {
        console.log(
          `[orchestrate] KP lookup ${kpLookups}/${kpLookupTotal} ` +
            `(${Math.round((Date.now() - t0) / 1000)}s, instances=${instances.length}, noKp=${skippedNoKp})`,
        );
      }
      const kpList = await buildFrozenKpListForClient(client.pageId, productLine);
      if (kpList.length === 0) {
        skippedNoKp += 1;
        continue;
      }
      instances.push({
        instanceKey: buildInstanceKey(campaignKey, client.pageId, productLine),
        clientPageId: client.pageId,
        companyName: client.companyName,
        productLine,
        stepCount: defaultStepCount(productLine as ProductLine),
        kpList,
      });
    }
  }

  const report = scheduleInstances({
    instances,
    mailboxes: mailboxEmails,
    windowStart,
    windowEnd,
    dailyCap,
  });
  // Merge pre-schedule KP skips into report semantics
  report.skippedNoKp += skippedNoKp;

  console.log(
    `[orchestrate] clients=${clients.length} instances=${instances.length} ` +
      `mailboxes=${mailboxEmails.length} dryRun=${opts.dryRun !== false} freshWrite=${Boolean(opts.freshWrite)}`,
  );

  const { writes, errors } = await writeScheduledHistory({
    scheduled: report.scheduled,
    templates,
    campaignKey,
    dryRun: opts.dryRun !== false, // default dry-run for safety
    freshWrite: opts.freshWrite === true,
  });

  const writeSummary = {
    created: writes.filter((w) => w.action === "created").length,
    updated: writes.filter((w) => w.action === "updated").length,
    skipped: writes.filter((w) => w.action === "skipped").length,
    errors: errors.length,
  };

  return {
    report,
    writeSummary,
    sample: summarizeScheduleForLog(report.scheduled),
    mailboxCount: mailboxEmails.length,
    clientCount: clients.length,
    instanceCount: instances.length,
  };
}
