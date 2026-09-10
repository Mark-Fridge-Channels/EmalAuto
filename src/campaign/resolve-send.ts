/**
 * CampaignHistoryDB outbound recipient gate (Client + KeyPerson relations).
 */

import type { AppConfig } from "../config/index.js";
import { getPage, type NotionPage } from "../notion/client.js";
import { readEmail, readSelectOrStatus } from "../notion/property-mapper.js";
import { readRelationPageId } from "../notion/relation.js";

export interface CampaignSendBundle {
  clientPageId: string;
  keyPersonPageId: string;
  recipientEmail: string;
  companyName: string;
  firstName: string;
  productLine: string;
}

export type CampaignResolveResult =
  | { ok: true; bundle: CampaignSendBundle }
  | { ok: false; reason: string };

function readCheckbox(prop: unknown): boolean {
  if (!prop || typeof prop !== "object") return false;
  return Boolean((prop as { checkbox?: boolean }).checkbox);
}

function firstNameFromKpName(name: string): string {
  const t = name.trim();
  if (!t) return "";
  return t.split(/\s+/)[0] ?? t;
}

/** True when the page looks like a CampaignHistoryDB row (not Interaction LOG). */
export function isCampaignHistoryPage(page: NotionPage): boolean {
  const props = page.properties as Record<string, unknown>;
  if (readRelationPageId(props.Template) || readRelationPageId(props.Client)) return true;
  const key = readSelectOrStatus(props["Campaign Key"]);
  return Boolean(key);
}

export async function resolveCampaignOutboundSend(
  historyPage: NotionPage,
  cfg: AppConfig,
): Promise<CampaignResolveResult> {
  const props = historyPage.properties as Record<string, unknown>;
  const clientPageId = readRelationPageId(props.Client);
  const keyPersonPageId = readRelationPageId(props.KeyPerson);
  if (!clientPageId) return { ok: false, reason: "missing Client relation" };
  if (!keyPersonPageId) return { ok: false, reason: "missing KeyPerson relation" };

  const [clientPage, keyPersonPage] = await Promise.all([
    getPage(clientPageId),
    getPage(keyPersonPageId),
  ]);
  const clientProps = clientPage.properties as Record<string, unknown>;
  if (readCheckbox(clientProps["Email Do Not Contact"])) {
    return { ok: false, reason: "Client Email Do Not Contact is checked" };
  }

  const kpProps = keyPersonPage.properties as Record<string, unknown>;
  const d = cfg.notion.dtc;
  const emailVerify = readSelectOrStatus(kpProps[d.key_person_columns.email_verified_status]);
  const accepted = new Set(
    (d.key_person_email_verified_values?.length
      ? d.key_person_email_verified_values
      : [d.key_person_email_verified_value]
    ).map((s) => s.trim()),
  );
  if (!accepted.has(emailVerify)) {
    return {
      ok: false,
      reason: `KeyPerson Email Verified Status is "${emailVerify || "(empty)"}" (required one of: ${[...accepted].join(", ")})`,
    };
  }
  const employment = readSelectOrStatus(kpProps["Current Employment Confirmed"]);
  if (employment === "No") {
    return { ok: false, reason: "KeyPerson Current Employment Confirmed is No" };
  }

  const recipientEmail = readEmail(kpProps[d.key_person_columns.email]);
  if (!recipientEmail || !/@/.test(recipientEmail)) {
    return { ok: false, reason: "KeyPerson has no valid Email" };
  }

  const companyName =
    readSelectOrStatus(clientProps["Company Name"]) ||
    // title
    (() => {
      const t = clientProps["Company Name"] as { type?: string; title?: Array<{ plain_text?: string }> };
      if (t?.type === "title" && Array.isArray(t.title)) {
        return t.title.map((x) => x.plain_text ?? "").join("").trim();
      }
      return "";
    })();

  const kpNameProp = kpProps.name ?? kpProps.Name;
  const kpName =
    typeof kpNameProp === "object" && kpNameProp && (kpNameProp as { type?: string }).type === "title"
      ? ((kpNameProp as { title?: Array<{ plain_text?: string }> }).title ?? [])
          .map((x) => x.plain_text ?? "")
          .join("")
          .trim()
      : readSelectOrStatus(kpNameProp);

  return {
    ok: true,
    bundle: {
      clientPageId,
      keyPersonPageId,
      recipientEmail: recipientEmail.toLowerCase(),
      companyName,
      firstName: firstNameFromKpName(kpName),
      productLine: readSelectOrStatus(props["Product Line"]),
    },
  };
}
