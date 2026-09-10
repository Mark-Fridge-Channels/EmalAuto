import { loadConfig } from "../config/index.js";
import { createPageInDatabase, queryDatabase, updatePage } from "../notion/client.js";
import {
  notionEmail,
  notionNumber,
  notionRelation,
  notionRichText,
  notionSelect,
  notionTitle,
  notionDateTimeAmericaNewYork,
} from "../notion/property-mapper.js";
import { etWallTimeToDate, pickEtBusinessSendTime } from "./business-days.js";
import type { RankedKp } from "./kp-rank.js";
import type { ScheduledInstance } from "./scheduler.js";
import { buildTaskId } from "./scheduler.js";
import type { CampaignTemplateRow, ProductLine } from "./types.js";

export interface HistoryWriteResult {
  taskId: string;
  pageId: string;
  action: "created" | "updated" | "skipped";
}

function templateMap(templates: CampaignTemplateRow[]): Map<string, CampaignTemplateRow> {
  const m = new Map<string, CampaignTemplateRow>();
  for (const t of templates) m.set(`${t.productLine}:${t.stepIndex}`, t);
  return m;
}

async function findByTaskId(databaseId: string, taskId: string): Promise<string | null> {
  const res = await queryDatabase(databaseId, {
    pageSize: 3,
    filter: { property: "Task ID", title: { equals: taskId } },
  });
  return res.results[0]?.id ?? null;
}

export async function writeScheduledHistory(opts: {
  scheduled: ScheduledInstance[];
  templates: CampaignTemplateRow[];
  campaignKey: string;
  dryRun?: boolean;
  /**
   * Skip find-by-Task-ID before create (first full write into an empty History DB).
   * Cuts Notion traffic roughly in half vs create+lookup.
   */
  freshWrite?: boolean;
  /** @deprecated Prefer per-task randomized ET business hours via pickEtBusinessSendTime. */
  sendHourEt?: number;
  /** Inclusive start hour in America/New_York (default 9). */
  sendWindowStartHourEt?: number;
  /** Exclusive end hour in America/New_York (default 17 → last hour is 16). */
  sendWindowEndHourEtExclusive?: number;
}): Promise<{ writes: HistoryWriteResult[]; errors: Array<{ taskId: string; error: string }> }> {
  const cfg = loadConfig();
  const databaseId = cfg.notion.campaign.history_database_id;
  if (!databaseId) throw new Error("NOTION_CAMPAIGN_HISTORY_DATABASE_ID is not configured");

  const tmap = templateMap(opts.templates);
  const writes: HistoryWriteResult[] = [];
  const errors: Array<{ taskId: string; error: string }> = [];
  const fixedHour = opts.sendHourEt;
  const startHour = opts.sendWindowStartHourEt ?? 9;
  const endHourEx = opts.sendWindowEndHourEtExclusive ?? 17;

  let plannedTasks = 0;
  for (const item of opts.scheduled) {
    if (!item.atRisk && item.steps.length > 0) plannedTasks += item.steps.length;
  }
  let doneTasks = 0;
  const writeStartedAt = Date.now();

  for (const item of opts.scheduled) {
    if (item.atRisk || item.steps.length === 0) continue;
    const { instance, fcAccount } = item;
    const kp0 = instance.kpList[0]!;
    const payloadBase = {
      kp_list: instance.kpList.map((k: RankedKp) => ({
        id: k.pageId,
        email: k.email,
        name: k.name,
        tier: k.tier,
      })),
      kp_list_index: 0,
      active_key_person_id: null as string | null,
      instance_key: instance.instanceKey,
      product_line: instance.productLine,
    };

    for (const step of item.steps) {
      const taskId = buildTaskId(
        opts.campaignKey,
        instance.clientPageId,
        instance.productLine,
        step.stepIndex,
      );
      const tmpl = tmap.get(`${instance.productLine}:${step.stepIndex}`);
      if (!tmpl) {
        errors.push({ taskId, error: `missing template for ${instance.productLine}#${step.stepIndex}` });
        continue;
      }

      const wall =
        fixedHour != null
          ? { hour: fixedHour, minute: 0 }
          : pickEtBusinessSendTime(taskId, {
              startHourEt: startHour,
              endHourEtExclusive: endHourEx,
            });
      const triggerAt = etWallTimeToDate(step.triggerYmd, wall.hour, wall.minute);
      const properties: Record<string, unknown> = {
        "Task ID": notionTitle(taskId),
        "OutReach Status": notionSelect("Todo"),
        Action: notionSelect("Send Email"),
        Platform: notionSelect("Email"),
        InNOut: notionSelect("Out"),
        Client: notionRelation([instance.clientPageId]),
        KeyPerson: notionRelation([kp0.pageId]),
        Template: notionRelation([tmpl.pageId]),
        "Product Line": notionSelect(instance.productLine),
        "Step Index": notionNumber(step.stepIndex),
        "Campaign Key": notionSelect(opts.campaignKey),
        FCAccount: notionEmail(fcAccount),
        "Trigger Time": notionDateTimeAmericaNewYork(triggerAt),
        "Outreach Subject": notionRichText(""),
        "Outreach Body": notionRichText(""),
        Payload: notionRichText(JSON.stringify(payloadBase)),
      };

      if (opts.dryRun) {
        writes.push({ taskId, pageId: "(dry-run)", action: "skipped" });
        doneTasks += 1;
        continue;
      }

      try {
        const existing = opts.freshWrite ? null : await findByTaskId(databaseId, taskId);
        if (existing) {
          // Only refresh unsent rows
          await updatePage(existing, properties);
          writes.push({ taskId, pageId: existing, action: "updated" });
        } else {
          const page = await createPageInDatabase(databaseId, properties);
          writes.push({ taskId, pageId: page.id, action: "created" });
        }
      } catch (e) {
        errors.push({ taskId, error: e instanceof Error ? e.message : String(e) });
      }

      doneTasks += 1;
      if (doneTasks === 1 || doneTasks % 25 === 0 || doneTasks === plannedTasks) {
        console.log(
          `[history-writer] ${doneTasks}/${plannedTasks} ` +
            `(created=${writes.filter((w) => w.action === "created").length} ` +
            `updated=${writes.filter((w) => w.action === "updated").length} ` +
            `errors=${errors.length} ` +
            `${Math.round((Date.now() - writeStartedAt) / 1000)}s)`,
        );
      }
    }
  }

  return { writes, errors };
}

export function summarizeScheduleForLog(
  scheduled: ScheduledInstance[],
): Array<Record<string, unknown>> {
  return scheduled.slice(0, 20).map((s) => ({
    instanceKey: s.instance.instanceKey,
    company: s.instance.companyName,
    productLine: s.instance.productLine as ProductLine,
    fcAccount: s.fcAccount,
    kpCount: s.instance.kpList.length,
    kp0: s.instance.kpList[0]?.email ?? null,
    steps: s.steps.map((x) => `${x.stepIndex}@${x.triggerYmd}`).join(","),
    atRisk: s.atRisk,
    riskReason: s.riskReason,
  }));
}
