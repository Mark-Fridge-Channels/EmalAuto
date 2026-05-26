/**
 * DTC Entity / Key Person gates for outbound Send Email rows on Interaction LOG.
 */

import type { AppConfig } from "../config/index.js";
import { getPage, updatePage, type NotionPage } from "./client.js";
import { readEmail, readSelectOrStatus, statusOrSelect } from "./property-mapper.js";
import { notionUrlToPageId } from "./crm-snapshot.js";
import { readRelationPageId } from "./relation.js";

export interface DtcSendBundle {
  entityPageId: string;
  keyPersonPageId: string;
  targetStatus: string;
  recipientEmail: string;
}

export type DtcResolveResult =
  | { ok: true; bundle: DtcSendBundle }
  | { ok: false; reason: string };

function readPlainStatusOrSelect(prop: unknown): string {
  return readSelectOrStatus(prop as never);
}

/**
 * Load DTC relations from an Interaction LOG page, validate send preconditions,
 * and resolve the recipient from Key Person `Email`.
 */
export async function resolveDtcOutboundSend(
  ilPage: NotionPage,
  cfg: AppConfig,
): Promise<DtcResolveResult> {
  const d = cfg.notion.dtc;
  const props = ilPage.properties as Record<string, unknown>;

  const entityPageId = readRelationPageId(props[d.il_columns.dtc_entity]);
  const keyPersonPageId = readRelationPageId(props[d.il_columns.dtc_key_person]);
  const currentStatus = readPlainStatusOrSelect(props[d.il_columns.current_status]);
  const targetStatus = readPlainStatusOrSelect(props[d.il_columns.target_status]);

  if (!entityPageId) {
    return { ok: false, reason: `missing DTC Entity relation (${d.il_columns.dtc_entity})` };
  }
  if (!keyPersonPageId) {
    return { ok: false, reason: `missing DTC Key Person relation (${d.il_columns.dtc_key_person})` };
  }
  if (!currentStatus) {
    return { ok: false, reason: `missing Current Status (${d.il_columns.current_status})` };
  }
  if (!targetStatus) {
    return { ok: false, reason: `missing Target Status (${d.il_columns.target_status})` };
  }

  const [entityPage, keyPersonPage] = await Promise.all([
    getPage(entityPageId),
    getPage(keyPersonPageId),
  ]);
  const entityProps = entityPage.properties as Record<string, unknown>;
  const kpProps = keyPersonPage.properties as Record<string, unknown>;

  const entityColdReach = readPlainStatusOrSelect(entityProps[d.entity_columns.cold_reach_status]);
  if (entityColdReach !== currentStatus) {
    return {
      ok: false,
      reason: `DTC Entity ColdReach Status is "${entityColdReach || '(empty)'}" but Current Status is "${currentStatus}"`,
    };
  }

  const emailVerify = readPlainStatusOrSelect(kpProps[d.key_person_columns.email_verified_status]);
  if (emailVerify !== d.key_person_email_verified_value) {
    return {
      ok: false,
      reason: `DTC Key Person Email Verified Status is "${emailVerify || '(empty)'}" (required: ${d.key_person_email_verified_value})`,
    };
  }

  const recipientEmail = readEmail(kpProps[d.key_person_columns.email]);
  if (!recipientEmail || !/@/.test(recipientEmail)) {
    return {
      ok: false,
      reason: `DTC Key Person has no valid Email (${d.key_person_columns.email})`,
    };
  }

  return {
    ok: true,
    bundle: {
      entityPageId,
      keyPersonPageId,
      targetStatus,
      recipientEmail: recipientEmail.toLowerCase(),
    },
  };
}

async function setDtcEntityColdReachStatus(
  entityPageId: string,
  statusName: string,
  cfg: AppConfig,
): Promise<void> {
  const col = cfg.notion.dtc.entity_columns.cold_reach_status;
  const entityPage = await getPage(entityPageId);
  const statusProp = (entityPage.properties as Record<string, unknown>)[col];
  await updatePage(entityPageId, {
    [col]: statusOrSelect(statusProp, statusName),
  });
}

/** After a successful send, set DTC Entity ColdReach Status to IL Target Status. */
export async function updateDtcEntityColdReachAfterSend(
  bundle: Pick<DtcSendBundle, "entityPageId" | "targetStatus">,
  cfg: AppConfig,
): Promise<void> {
  await setDtcEntityColdReachStatus(bundle.entityPageId, bundle.targetStatus, cfg);
}

/**
 * On bounce, revert DTC Entity ColdReach Status to IL Current Status
 * (undo the post-send advance to Target Status).
 */
async function resolveDtcEntityPageId(
  cfg: AppConfig,
  opts: { ilNotionPageId?: string | null; entityNotionUrl?: string | null },
): Promise<{ entityPageId: string | null; source: string }> {
  const d = cfg.notion.dtc;
  const ilId = opts.ilNotionPageId?.trim();
  if (ilId) {
    const ilPage = await getPage(ilId);
    const props = ilPage.properties as Record<string, unknown>;
    const fromRel = readRelationPageId(props[d.il_columns.dtc_entity]);
    if (fromRel) return { entityPageId: fromRel, source: "il_dtc_entity_relation" };
  }
  const fromUrl = notionUrlToPageId(opts.entityNotionUrl);
  if (fromUrl) return { entityPageId: fromUrl, source: "outbound_entity_notion_url" };
  return { entityPageId: null, source: "none" };
}

/** After a **human** inbound reply, set linked DTC Entity ColdReach Status (default `Humen`). */
export async function markDtcEntityColdReachOnHumanReply(
  cfg: AppConfig,
  opts: { ilNotionPageId?: string | null; entityNotionUrl?: string | null },
): Promise<{ updated: boolean; entityPageId?: string; status?: string; source?: string }> {
  const status = cfg.notion.dtc.human_reply_cold_reach_status;
  const { entityPageId, source } = await resolveDtcEntityPageId(cfg, opts);
  if (!entityPageId) {
    return { updated: false, source };
  }
  await setDtcEntityColdReachStatus(entityPageId, status, cfg);
  return { updated: true, entityPageId, status, source };
}

async function resolveDtcKeyPersonPageId(
  cfg: AppConfig,
  opts: { ilNotionPageId?: string | null; keyPersonNotionUrl?: string | null },
): Promise<{ keyPersonPageId: string | null; source: string }> {
  const d = cfg.notion.dtc;
  const ilId = opts.ilNotionPageId?.trim();
  if (ilId) {
    const ilPage = await getPage(ilId);
    const props = ilPage.properties as Record<string, unknown>;
    const fromRel = readRelationPageId(props[d.il_columns.dtc_key_person]);
    if (fromRel) return { keyPersonPageId: fromRel, source: "il_dtc_key_person_relation" };
  }
  const fromUrl = notionUrlToPageId(opts.keyPersonNotionUrl);
  if (fromUrl) return { keyPersonPageId: fromUrl, source: "outbound_key_person_notion_url" };
  return { keyPersonPageId: null, source: "none" };
}

/** After a matched bounce, set DTC Key Person Email Verified Status to Send Email Failed. */
export async function markDtcKeyPersonEmailFailedOnBounce(
  cfg: AppConfig,
  opts: { ilNotionPageId?: string | null; keyPersonNotionUrl?: string | null },
): Promise<{ updated: boolean; keyPersonPageId?: string; status?: string; source?: string }> {
  const status = cfg.notion.dtc.key_person_email_failed_value;
  const { keyPersonPageId, source } = await resolveDtcKeyPersonPageId(cfg, opts);
  if (!keyPersonPageId) {
    return { updated: false, source };
  }
  const col = cfg.notion.dtc.key_person_columns.email_verified_status;
  const kpPage = await getPage(keyPersonPageId);
  const statusProp = (kpPage.properties as Record<string, unknown>)[col];
  await updatePage(keyPersonPageId, {
    [col]: statusOrSelect(statusProp, status),
  });
  return { updated: true, keyPersonPageId, status, source };
}

export async function rollbackDtcEntityColdReachOnBounce(
  ilNotionPageId: string,
  cfg: AppConfig,
): Promise<{ rolledBack: boolean; entityPageId?: string; currentStatus?: string }> {
  const ilPage = await getPage(ilNotionPageId);
  const d = cfg.notion.dtc;
  const props = ilPage.properties as Record<string, unknown>;
  const entityPageId = readRelationPageId(props[d.il_columns.dtc_entity]);
  const currentStatus = readPlainStatusOrSelect(props[d.il_columns.current_status]);

  if (!entityPageId || !currentStatus) {
    return { rolledBack: false };
  }

  await setDtcEntityColdReachStatus(entityPageId, currentStatus, cfg);
  return { rolledBack: true, entityPageId, currentStatus };
}
