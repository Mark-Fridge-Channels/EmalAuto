/**
 * Notion -> send queue.
 *
 * Every `polling.notion_interval_ms`, query the configured DB for rows where:
 *   Status     ∈ {todo}
 *   Action     ∈ {send, reply}
 *   Platform   = Email
 *   InNOut     = Out
 *   Trigger Time  REQUIRED — current UTC time must fall inside the window:
 *                 - start (required) ≤ now
 *                 - end   (optional) ≥ now  (no end = open-ended window)
 *
 * All comparisons are in UTC. Notion's date filter and `new Date(...)` parsing
 * both honor the timezone embedded in the stored ISO string, so a value saved
 * as "+08:00" or "Z" is converted to the same UTC instant before comparison.
 *
 * For each hit, enqueue a `send` job keyed by Notion `page_id` (idempotent).
 *
 * We do NOT flip status here — the send worker is responsible for the
 * sending→Success/Failure transitions. We only enqueue.
 */

import { logger } from "../utils/logger.js";
import { loadConfig } from "../config/index.js";
import { queryDatabase, retrieveDatabase } from "./client.js";
import { sendQueue } from "../queues/queues.js";
import { buildPropertyResolver, readDateEnd, readDateStart } from "./property-mapper.js";

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Cache of Notion column-type lookups. Notion validates filter clauses against
 * the actual column type *before* honoring OR semantics, so we must emit the
 * right discriminator (`status` vs `select`) per column. We refresh lazily.
 */
let propertyTypes: Record<string, string> | null = null;

async function ensurePropertyTypes(): Promise<Record<string, string>> {
  if (propertyTypes) return propertyTypes;
  const cfg = loadConfig();
  const db = await retrieveDatabase(cfg.notion.database_id);
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(db.properties)) {
    out[name] = def.type;
  }
  propertyTypes = out;
  return out;
}

/** Build a Notion filter clause for a column whose Notion type may be either select or status. */
function selectLikeFilter(
  columnName: string,
  value: string,
  types: Record<string, string>,
): unknown {
  const t = types[columnName];
  if (t === "status") return { property: columnName, status: { equals: value } };
  return { property: columnName, select: { equals: value } };
}

/**
 * Notion filter for the Trigger Time window — start-side only.
 *
 * Notion's date filter compares against `date.start`, so we can require:
 *   1. column not empty (the user MUST fill it)
 *   2. start ≤ now (window has begun)
 *
 * The end-side bound (`end ≥ now`) is enforced in `isWithinTriggerWindow`
 * after fetch, because Notion has no filter operator for `date.end`.
 */
function triggerTimeDueFilter(columnName: string, nowIso: string): unknown {
  return {
    and: [
      { property: columnName, date: { is_not_empty: true } },
      { property: columnName, date: { on_or_before: nowIso } },
    ],
  };
}

/** Require non-empty sender column (FCAccount mapped name). Type-aware for Notion filter validation. */
function nonEmptySenderFilter(columnName: string, types: Record<string, string>): unknown {
  const t = types[columnName];
  if (t === "email") return { property: columnName, email: { is_not_empty: true } };
  if (t === "title") return { property: columnName, title: { is_not_empty: true } };
  return { property: columnName, rich_text: { is_not_empty: true } };
}

async function buildFilter(nowIso: string): Promise<unknown> {
  const cfg = loadConfig();
  const p = cfg.notion.property_names;
  const types = await ensurePropertyTypes();
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

/**
 * UTC-precise window check on a single Notion page:
 *   start ≤ now (already filtered by Notion, re-checked defensively)
 *   end   ≥ now  if end is set
 * Returns `null` when the page should be enqueued; otherwise a reason string.
 */
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

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const cfg = loadConfig();
  try {
    // Snapshot 'now' once per tick so the Notion-side filter and the
    // application-side window check use the exact same UTC instant.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    let cursor: string | undefined;
    let totalEnq = 0;
    let totalSkipped = 0;
    do {
      const opts: { pageSize: number; filter: unknown; startCursor?: string } = {
        pageSize: 25,
        filter: await buildFilter(nowIso),
      };
      if (cursor) opts.startCursor = cursor;
      const res = await queryDatabase(cfg.notion.database_id, opts);
      for (const page of res.results) {
        const why = isOutsideTriggerWindow(page, nowMs);
        if (why) {
          totalSkipped += 1;
          logger.debug({ notionPageId: page.id, reason: why }, "skip: trigger window");
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
    if (totalEnq > 0 || totalSkipped > 0) {
      logger.info(
        { enqueued: totalEnq, skipped_outside_window: totalSkipped },
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
  logger.info({ intervalMs: cfg.polling.notion_interval_ms }, "notion poller started");
}

export function stopNotionPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("notion poller stopped");
  }
}
