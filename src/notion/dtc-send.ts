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
  recipientEmail: string;
}

export type DtcResolveResult =
  | { ok: true; bundle: DtcSendBundle }
  | { ok: false; reason: string };

function readPlainStatusOrSelect(prop: unknown): string {
  return readSelectOrStatus(prop as never);
}

/**
 * Load DTC relations from an Interaction LOG page, validate Key Person email gate,
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

  if (!entityPageId) {
    return { ok: false, reason: `missing DTC Entity relation (${d.il_columns.dtc_entity})` };
  }
  if (!keyPersonPageId) {
    return { ok: false, reason: `missing DTC Key Person relation (${d.il_columns.dtc_key_person})` };
  }

  const keyPersonPage = await getPage(keyPersonPageId);
  const kpProps = keyPersonPage.properties as Record<string, unknown>;

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
      recipientEmail: recipientEmail.toLowerCase(),
    },
  };
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
