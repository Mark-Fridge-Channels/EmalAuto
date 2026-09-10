/**
 * Notion -> send queue.
 *
 * Every `polling.notion_interval_ms`, query configured DBs for rows where:
 *   Status     ∈ {todo}
 *   Action     ∈ {send, reply}
 *   Platform   = Email
 *   InNOut     = Out
 *   Trigger Time  REQUIRED — current UTC time must fall inside the window:
 *                 - start (required) ≤ now
 *                 - end   (optional) ≥ now  (no end = open-ended window)
 *
 * Sources (Scheme A):
 *   - CampaignHistoryDB when `campaign.poll_history` + history_database_id set
 *   - Interaction LOG when `campaign.poll_interaction_log` (legacy)
 *
 * Property types are cached **per database** (History Status is select; IL may differ).
 */

import { logger } from "../utils/logger.js";
import { loadConfig } from "../config/index.js";
import { queryDatabase, retrieveDatabase } from "./client.js";
import { sendQueue } from "../queues/queues.js";
import { buildPropertyResolver, readDateEnd, readDateStart } from "./property-mapper.js";

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/** Cache of Notion column-type lookups, keyed by database id. */
const propertyTypesByDb = new Map<string, Record<string, string>>();

async function ensurePropertyTypes(databaseId: string): Promise<Record<string, string>> {
  const cached = propertyTypesByDb.get(databaseId);
  if (cached) return cached;
  const db = await retrieveDatabase(databaseId);
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(db.properties)) {
    out[name] = def.type;
  }
  propertyTypesByDb.set(databaseId, out);
  return out;
}

function selectLikeFilter(
  columnName: string,
  value: string,
  types: Record<string, string>,
): unknown {
  const t = types[columnName];
  if (t === "status") return { property: columnName, status: { equals: value } };
  return { property: columnName, select: { equals: value } };
}

function triggerTimeDueFilter(columnName: string, nowIso: string): unknown {
  return {
    and: [
      { property: columnName, date: { is_not_empty: true } },
      { property: columnName, date: { on_or_before: nowIso } },
    ],
  };
}

function nonEmptySenderFilter(columnName: string, types: Record<string, string>): unknown {
  const t = types[columnName];
  if (t === "email") return { property: columnName, email: { is_not_empty: true } };
  if (t === "title") return { property: columnName, title: { is_not_empty: true } };
  return { property: columnName, rich_text: { is_not_empty: true } };
}

async function buildFilter(databaseId: string, nowIso: string): Promise<unknown> {
  const cfg = loadConfig();
  const p = cfg.notion.property_names;
  const types = await ensurePropertyTypes(databaseId);
  return {
    and: [
      selectLikeFilter(p.Status, cfg.notion.status_values.todo, types),
      {
        or: [
          selectLikeFilter(p.Action, cfg.notion.action_values.send, types),
          selectLikeFilter(p.Action, cfg.notion.action_values.reply, types),
        ],
      },
      selectLikeFilter(p.Platform, cfg.notion.platform_value, types),
      selectLikeFilter(p.InNOut, cfg.notion.in_n_out_value, types),
      triggerTimeDueFilter(p.trigger_time, nowIso),
      nonEmptySenderFilter(p.sender_email, types),
    ],
  };
}

function isOutsideTriggerWindow(
  page: { properties: Record<string, any> },
  nowMs: number,
): string | null {
  const cfg = loadConfig();
  const { pick } = buildPropertyResolver(cfg);
  const prop = pick(page.properties, "trigger_time");
  const startStr = readDateStart(prop);
  if (!startStr) return "trigger_time is empty";
  const startMs = new Date(startStr).getTime();
  if (!Number.isFinite(startMs)) return `trigger_time.start unparseable: "${startStr}"`;
  if (startMs > nowMs) return `trigger_time.start (${startStr}) is in the future`;
  const endStr = readDateEnd(prop);
  if (endStr) {
    const endMs = new Date(endStr).getTime();
    if (!Number.isFinite(endMs)) return `trigger_time.end unparseable: "${endStr}"`;
    if (endMs < nowMs) return `trigger_time.end (${endStr}) has already passed`;
  }
  return null;
}

function pollTargets(): Array<{ databaseId: string; label: string }> {
  const cfg = loadConfig();
  const out: Array<{ databaseId: string; label: string }> = [];
  if (cfg.notion.campaign.poll_history && cfg.notion.campaign.history_database_id) {
    out.push({ databaseId: cfg.notion.campaign.history_database_id, label: "campaign_history" });
  }
  if (cfg.notion.campaign.poll_interaction_log && cfg.notion.database_id) {
    out.push({ databaseId: cfg.notion.database_id, label: "interaction_log" });
  }
  // Safety: if both flags somehow false, still poll IL so ops is not silent.
  if (out.length === 0 && cfg.notion.database_id) {
    out.push({ databaseId: cfg.notion.database_id, label: "interaction_log" });
  }
  return out;
}

async function pollOneDatabase(
  databaseId: string,
  label: string,
  nowMs: number,
  nowIso: string,
): Promise<{ enqueued: number; skipped: number }> {
  let cursor: string | undefined;
  let totalEnq = 0;
  let totalSkipped = 0;
  do {
    const opts: { pageSize: number; filter: unknown; startCursor?: string } = {
      pageSize: 25,
      filter: await buildFilter(databaseId, nowIso),
    };
    if (cursor) opts.startCursor = cursor;
    const res = await queryDatabase(databaseId, opts);
    for (const page of res.results) {
      const why = isOutsideTriggerWindow(page, nowMs);
      if (why) {
        totalSkipped += 1;
        logger.debug({ notionPageId: page.id, database: label, reason: why }, "skip: trigger window");
        continue;
      }
      await sendQueue.add(
        "send",
        { notionPageId: page.id },
        { jobId: `send__${page.id}` },
      );
      totalEnq += 1;
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return { enqueued: totalEnq, skipped: totalSkipped };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const targets = pollTargets();
    let totalEnq = 0;
    let totalSkipped = 0;
    for (const t of targets) {
      const r = await pollOneDatabase(t.databaseId, t.label, nowMs, nowIso);
      totalEnq += r.enqueued;
      totalSkipped += r.skipped;
      if (r.enqueued > 0 || r.skipped > 0) {
        logger.info(
          {
            database: t.label,
            enqueued: r.enqueued,
            skipped_outside_window: r.skipped,
          },
          "notion poll: database tick",
        );
      }
    }
    if (totalEnq > 0 || totalSkipped > 0) {
      logger.info(
        { enqueued: totalEnq, skipped_outside_window: totalSkipped, databases: targets.length },
        "notion poll: tick done",
      );
    }
  } catch (err) {
    logger.error({ err }, "notion poller tick failed");
  } finally {
    inFlight = false;
  }
}

export function startNotionPoller(): void {
  if (timer) return;
  const cfg = loadConfig();
  void tick();
  timer = setInterval(() => void tick(), cfg.polling.notion_interval_ms);
  logger.info(
    {
      intervalMs: cfg.polling.notion_interval_ms,
      pollHistory: cfg.notion.campaign.poll_history,
      pollIl: cfg.notion.campaign.poll_interaction_log,
    },
    "notion poller started",
  );
}

export function stopNotionPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("notion poller stopped");
  }
}

/** Whether the Notion send-task poller interval is active (runs in the API process). */
export function isNotionPollerRunning(): boolean {
  return timer !== null;
}

/** Test helper: clear property-type cache between suites. */
export function _resetPollerPropertyTypeCacheForTests(): void {
  propertyTypesByDb.clear();
}
