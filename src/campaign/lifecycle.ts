import { loadConfig } from "../config/index.js";
import { getPage, queryDatabase, updatePage } from "../notion/client.js";
import {
  notionDateTimeAmericaNewYork,
  notionRelation,
  notionRichText,
  readRichText,
  statusOrSelect,
} from "../notion/property-mapper.js";
import { readRelationPageId } from "../notion/relation.js";
import { logger } from "../utils/logger.js";
import { addBusinessDaysYmd, etWallTimeToDate, ymdInTimeZone } from "./business-days.js";

export interface KpListEntry {
  id: string;
  email?: string;
  name?: string;
  tier?: number;
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function selectLikeEquals(column: string, value: string, propType: string | undefined): unknown {
  if (propType === "status") return { property: column, status: { equals: value } };
  return { property: column, select: { equals: value } };
}

/** Cancel open email Todos/Sending for a Client across CampaignHistoryDB. */
export async function cancelOpenEmailTodosForClient(
  clientPageId: string,
  reason: string,
): Promise<{ cancelled: number }> {
  const cfg = loadConfig();
  const dbId = cfg.notion.campaign.history_database_id;
  if (!dbId) return { cancelled: 0 };

  const statusCol = cfg.notion.property_names.Status;
  const cancelledValue = cfg.notion.campaign.status_cancelled;
  const openStatuses = [cfg.notion.status_values.todo, cfg.notion.status_values.in_flight];

  let cancelled = 0;
  for (const st of openStatuses) {
    let cursor: string | undefined;
    do {
      const page = await queryDatabase(dbId, {
        pageSize: 50,
        startCursor: cursor,
        filter: {
          and: [
            { property: "Client", relation: { contains: clientPageId } },
            { property: statusCol, select: { equals: st } },
            {
              property: cfg.notion.property_names.Platform,
              select: { equals: cfg.notion.platform_value },
            },
            {
              property: cfg.notion.property_names.InNOut,
              select: { equals: cfg.notion.in_n_out_value },
            },
          ],
        },
      });
      for (const row of page.results) {
        const statusProp = row.properties?.[statusCol];
        await updatePage(row.id, {
          [statusCol]: statusOrSelect(statusProp, cancelledValue),
          [cfg.notion.property_names.result_remark]: notionRichText(reason),
        });
        cancelled += 1;
      }
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
  }

  logger.info({ clientPageId, cancelled, reason }, "campaign: cancelled open email todos for client");
  return { cancelled };
}

/**
 * On Hard Bounce: advance kp_list for the campaign instance.
 * Soft bounce callers should not invoke this.
 * Clears Outreach Subject/Body on open instance rows so the next KP gets a fresh template render.
 */
export async function advanceKpOnHardBounce(historyPageId: string): Promise<{
  advanced: boolean;
  exhausted: boolean;
  nextKeyPersonId?: string;
}> {
  const cfg = loadConfig();
  const page = await getPage(historyPageId);
  const props = page.properties as Record<string, unknown>;
  const payloadCol = cfg.notion.property_names.payload;
  const payload = parsePayload(readRichText(props[payloadCol]));
  const kpList = Array.isArray(payload.kp_list) ? (payload.kp_list as KpListEntry[]) : [];
  let index = typeof payload.kp_list_index === "number" ? payload.kp_list_index : 0;
  const instanceKey = typeof payload.instance_key === "string" ? payload.instance_key : "";

  const bouncedKpId = readRelationPageId(props.KeyPerson);
  // Mark bounced KP failed
  if (bouncedKpId) {
    try {
      const col = cfg.notion.dtc.key_person_columns.email_verified_status;
      const kpPage = await getPage(bouncedKpId);
      await updatePage(bouncedKpId, {
        [col]: statusOrSelect(
          (kpPage.properties as Record<string, unknown>)[col],
          cfg.notion.dtc.key_person_email_failed_value,
        ),
      });
    } catch (err) {
      logger.warn({ err, bouncedKpId }, "campaign: failed to mark KP Send Email Failed");
    }
  }

  const nextIndex = index + 1;
  if (!kpList.length || nextIndex >= kpList.length) {
    // Exhausted — fail current, cancel remaining of instance
    await failAndCancelInstance(historyPageId, instanceKey, "Hard bounce: KP list exhausted");
    return { advanced: false, exhausted: true };
  }

  const next = kpList[nextIndex]!;
  const nextId = next.id;
  payload.kp_list_index = nextIndex;
  payload.active_key_person_id = null;

  const dbId = cfg.notion.campaign.history_database_id;
  if (!dbId || !instanceKey) {
    // At least update current page — clear Subject/Body so next send re-renders for new KP
    await updatePage(historyPageId, {
      KeyPerson: notionRelation([nextId]),
      [payloadCol]: notionRichText(JSON.stringify(payload)),
      [cfg.notion.property_names.Status]: statusOrSelect(
        props[cfg.notion.property_names.Status],
        cfg.notion.status_values.todo,
      ),
      [cfg.notion.property_names.subject]: notionRichText(""),
      [cfg.notion.property_names.body]: notionRichText(""),
      [cfg.notion.property_names.result_remark]: notionRichText(
        `Hard bounce → switched to KP ${next.email ?? nextId}`,
      ),
      [cfg.notion.property_names.trigger_time]: notionDateTimeAmericaNewYork(
        etWallTimeToDate(addBusinessDaysYmd(ymdInTimeZone(new Date()), 1), 10, 0),
      ),
    });
    return { advanced: true, exhausted: false, nextKeyPersonId: nextId };
  }

  // Update all open todos for this instance_key (payload text contains it)
  let cursor: string | undefined;
  do {
    const res = await queryDatabase(dbId, {
      pageSize: 50,
      startCursor: cursor,
      filter: {
        and: [
          {
            property: cfg.notion.property_names.payload,
            rich_text: { contains: instanceKey },
          },
          {
            or: [
              selectLikeEquals(
                cfg.notion.property_names.Status,
                cfg.notion.status_values.todo,
                "select",
              ),
              selectLikeEquals(
                cfg.notion.property_names.Status,
                cfg.notion.status_values.failure,
                "select",
              ),
              selectLikeEquals(
                cfg.notion.property_names.Status,
                cfg.notion.status_values.in_flight,
                "select",
              ),
            ],
          },
        ],
      },
    });
    for (const row of res.results) {
      const rowPayload = parsePayload(
        readRichText((row.properties as Record<string, unknown>)[payloadCol]),
      );
      if (rowPayload.instance_key !== instanceKey) continue;
      const statusName = cfg.notion.property_names.Status;
      const st = statusOrSelect(
        (row.properties as Record<string, unknown>)[statusName],
        // bounced current step back to Todo for retry with new KP; others stay Todo
        cfg.notion.status_values.todo,
      );
      const patch: Record<string, unknown> = {
        KeyPerson: notionRelation([nextId]),
        [payloadCol]: notionRichText(
          JSON.stringify({ ...rowPayload, kp_list_index: nextIndex, active_key_person_id: null }),
        ),
        [statusName]: st,
        // Drop A-personalized copy so B gets a fresh template render (First Name, etc.)
        [cfg.notion.property_names.subject]: notionRichText(""),
        [cfg.notion.property_names.body]: notionRichText(""),
      };
      if (row.id === historyPageId) {
        patch[cfg.notion.property_names.result_remark] = notionRichText(
          `Hard bounce → switched to KP ${next.email ?? nextId}`,
        );
        patch[cfg.notion.property_names.trigger_time] = notionDateTimeAmericaNewYork(
          etWallTimeToDate(addBusinessDaysYmd(ymdInTimeZone(new Date()), 1), 10, 0),
        );
      }
      await updatePage(row.id, patch);
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);

  return { advanced: true, exhausted: false, nextKeyPersonId: nextId };
}

/** After Graph send success: lock active KP on all open Todos of this instance. */
export async function lockActiveKeyPersonAfterSend(historyPageId: string): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(historyPageId);
  const props = page.properties as Record<string, unknown>;
  const payloadCol = cfg.notion.property_names.payload;
  const payload = parsePayload(readRichText(props[payloadCol]));
  const kpId = readRelationPageId(props.KeyPerson);
  const instanceKey = typeof payload.instance_key === "string" ? payload.instance_key : "";
  if (!kpId || !instanceKey) return;

  const dbId = cfg.notion.campaign.history_database_id;
  if (!dbId) {
    await updatePage(historyPageId, {
      [payloadCol]: notionRichText(
        JSON.stringify({ ...payload, active_key_person_id: kpId }),
      ),
    });
    return;
  }

  let cursor: string | undefined;
  do {
    const res = await queryDatabase(dbId, {
      pageSize: 50,
      startCursor: cursor,
      filter: {
        property: cfg.notion.property_names.payload,
        rich_text: { contains: instanceKey },
      },
    });
    for (const row of res.results) {
      const rowPayload = parsePayload(
        readRichText((row.properties as Record<string, unknown>)[payloadCol]),
      );
      if (rowPayload.instance_key !== instanceKey) continue;
      const statusName = readSelectOrStatusSafe(
        (row.properties as Record<string, unknown>)[cfg.notion.property_names.Status],
      );
      const openish = new Set([
        cfg.notion.status_values.todo,
        cfg.notion.status_values.in_flight,
        cfg.notion.status_values.success,
      ]);
      if (!openish.has(statusName) && row.id !== historyPageId) continue;
      await updatePage(row.id, {
        KeyPerson: notionRelation([kpId]),
        [payloadCol]: notionRichText(
          JSON.stringify({ ...rowPayload, active_key_person_id: kpId }),
        ),
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
}

function readSelectOrStatusSafe(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const p = prop as { type?: string; select?: { name?: string }; status?: { name?: string } };
  if (p.type === "status") return p.status?.name?.trim() ?? "";
  if (p.type === "select") return p.select?.name?.trim() ?? "";
  return "";
}

async function failAndCancelInstance(
  historyPageId: string,
  instanceKey: string,
  reason: string,
): Promise<void> {
  const cfg = loadConfig();
  const page = await getPage(historyPageId);
  const statusCol = cfg.notion.property_names.Status;
  await updatePage(historyPageId, {
    [statusCol]: statusOrSelect(
      (page.properties as Record<string, unknown>)[statusCol],
      cfg.notion.status_values.failure,
    ),
    [cfg.notion.property_names.result_remark]: notionRichText(reason),
  });

  const dbId = cfg.notion.campaign.history_database_id;
  if (!dbId || !instanceKey) return;

  let cursor: string | undefined;
  do {
    const res = await queryDatabase(dbId, {
      pageSize: 50,
      startCursor: cursor,
      filter: {
        and: [
          {
            property: cfg.notion.property_names.payload,
            rich_text: { contains: instanceKey },
          },
          {
            property: statusCol,
            select: { equals: cfg.notion.status_values.todo },
          },
        ],
      },
    });
    for (const row of res.results) {
      if (row.id === historyPageId) continue;
      const rowPayload = parsePayload(
        readRichText((row.properties as Record<string, unknown>)[cfg.notion.property_names.payload]),
      );
      if (rowPayload.instance_key !== instanceKey) continue;
      await updatePage(row.id, {
        [statusCol]: statusOrSelect(
          (row.properties as Record<string, unknown>)[statusCol],
          cfg.notion.campaign.status_cancelled,
        ),
        [cfg.notion.property_names.result_remark]: notionRichText(reason),
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
}
