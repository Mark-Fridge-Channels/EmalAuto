/**
 * Internal smoke: DTC + ASIN_Plus Email 1 through CampaignHistory → template render → Graph send.
 * Recipients are FC mailboxes (creates disposable KeyPersons tagged [SMOKE]).
 *
 *   npx tsx scripts/smoke-campaign-internal-send.ts
 */
import { loadConfig } from "../src/config/index.js";
import { refreshGraphAppsFromDb } from "../src/services/graph-apps.service.js";
import { createPageInDatabase, getPage, updatePage } from "../src/notion/client.js";
import {
  notionDateTimeAmericaNewYork,
  notionEmail,
  notionNumber,
  notionRelation,
  notionRichText,
  notionSelect,
  notionTitle,
} from "../src/notion/property-mapper.js";
import { listCampaignTemplates } from "../src/campaign/templates.js";
import { resolveCampaignOutboundSend, isCampaignHistoryPage } from "../src/campaign/resolve-send.js";
import { resolveCampaignCopy } from "../src/campaign/render-for-send.js";
import { markSending, writeSendSuccess } from "../src/notion/writer.js";
import { sendMail, findRecentSentMessage } from "../src/graph/mail.service.js";
import { coercePlainTextToHtml, ensureOutboundMailBody } from "../src/services/mail-signature.service.js";
import {
  buildUnsubscribeUrl,
  canIssueListUnsubscribeHeaders,
  createUnsubscribeToken,
} from "../src/services/list-unsubscribe.service.js";
import {
  buildOpenPixelUrl,
  canIssueOpenTracking,
  createOpenTrackToken,
  injectOpenPixel,
} from "../src/services/open-tracking.service.js";
import { queryDatabase } from "../src/notion/client.js";
import { sleep } from "../src/utils/sleep.js";

const FROM_DTC = "billy@getfridgechannel.com";
const TO_DTC = "ella@getfridgechannel.com";
const FROM_ASIN = "ella@getfridgechannel.com";
const TO_ASIN = "billy@getfridgechannel.com";

async function pickSmokeClientPageId(): Promise<string> {
  const cfg = loadConfig();
  // Prefer a Client that already has Has Verified Email
  const res = await queryDatabase(cfg.notion.campaign.client_database_id, {
    pageSize: 1,
    filter: {
      and: [
        { property: "Has Verified Email", formula: { checkbox: { equals: true } } },
        { property: "Email Do Not Contact", checkbox: { equals: false } },
      ],
    },
  });
  const id = res.results[0]?.id;
  if (!id) throw new Error("no Client with Has Verified Email for smoke Client relation");
  return id;
}

async function createSmokeKeyPerson(opts: {
  name: string;
  email: string;
  clientPageId: string;
}): Promise<string> {
  const cfg = loadConfig();
  const page = await createPageInDatabase(cfg.notion.campaign.key_person_database_id, {
    name: notionTitle(opts.name),
    Email: notionEmail(opts.email),
    "Email Verified Status": { status: { name: "Verified" } },
    "Current Employment Confirmed": notionSelect("Yes"),
    Client: notionRelation([opts.clientPageId]),
    Notes: notionRichText("SMOKE TEST KP — safe to archive after campaign smoke"),
  });
  return page.id;
}

async function createHistoryTodo(opts: {
  taskId: string;
  productLine: "DTC" | "ASIN_Plus";
  stepIndex: number;
  templatePageId: string;
  clientPageId: string;
  keyPersonPageId: string;
  fromMailbox: string;
}): Promise<string> {
  const cfg = loadConfig();
  const page = await createPageInDatabase(cfg.notion.campaign.history_database_id, {
    "Task ID": notionTitle(opts.taskId),
    "OutReach Status": notionSelect("Todo"),
    Action: notionSelect("Send Email"),
    Platform: notionSelect("Email"),
    InNOut: notionSelect("Out"),
    Client: notionRelation([opts.clientPageId]),
    KeyPerson: notionRelation([opts.keyPersonPageId]),
    Template: notionRelation([opts.templatePageId]),
    "Product Line": notionSelect(opts.productLine),
    "Step Index": notionNumber(opts.stepIndex),
    "Campaign Key": notionSelect(cfg.notion.campaign.campaign_key),
    FCAccount: notionEmail(opts.fromMailbox),
    "Trigger Time": notionDateTimeAmericaNewYork(new Date(Date.now() - 60_000)),
    "Outreach Subject": notionRichText(""),
    "Outreach Body": notionRichText(""),
    Payload: notionRichText(
      JSON.stringify({
        smoke: true,
        instance_key: `smoke:${opts.productLine}`,
        product_line: opts.productLine,
        kp_list: [{ id: opts.keyPersonPageId, email: "" }],
        kp_list_index: 0,
      }),
    ),
  });
  return page.id;
}

async function sendHistoryPage(notionPageId: string): Promise<{
  to: string;
  from: string;
  subject: string;
  bodyPreview: string;
  usedTemplate: boolean;
}> {
  const cfg = loadConfig();
  const page = await getPage(notionPageId);
  if (!isCampaignHistoryPage(page)) throw new Error("not a campaign history page");

  const camp = await resolveCampaignOutboundSend(page, cfg);
  if (!camp.ok) throw new Error(camp.reason);

  const props = page.properties as Record<string, unknown>;
  const subject0 = "";
  const body0 = "";
  const fromMailbox = (() => {
    const p = props.FCAccount as { type?: string; email?: string; rich_text?: Array<{ plain_text?: string }> };
    if (p?.type === "email") return (p.email ?? "").trim().toLowerCase();
    return (p?.rich_text ?? []).map((x) => x.plain_text ?? "").join("").trim().toLowerCase();
  })();
  if (!fromMailbox) throw new Error("missing FCAccount");

  const rendered = await resolveCampaignCopy({
    historyPage: page,
    subject: subject0,
    body: body0,
    bundle: camp.bundle,
    fromMailbox,
  });

  let bodyHtml = rendered.body.includes("<")
    ? rendered.body
    : rendered.body.replace(/\n/g, "<br>");
  bodyHtml = ensureOutboundMailBody(bodyHtml, fromMailbox, true, cfg.mail.opt_out_footer_text);
  bodyHtml = coercePlainTextToHtml(bodyHtml);

  const publicBase = cfg.mail.list_unsubscribe_public_base_url.trim();
  const secret = cfg.mail.list_unsubscribe_token_secret.trim();
  let listUnsubscribeUrl: string | undefined;
  if (canIssueListUnsubscribeHeaders(publicBase) && secret.length >= 8) {
    const token = createUnsubscribeToken(
      { recipientEmail: camp.bundle.recipientEmail, notionPageId },
      secret,
      cfg.mail.list_unsubscribe_token_ttl_days * 86400,
    );
    listUnsubscribeUrl = buildUnsubscribeUrl({
      publicBaseUrl: publicBase,
      unsubscribePath: cfg.mail.list_unsubscribe_path,
      token,
    });
  }
  if (
    canIssueOpenTracking({
      enabled: cfg.mail.open_tracking_enabled,
      publicBaseUrl: publicBase,
      secret,
    })
  ) {
    const openToken = createOpenTrackToken(
      { recipientEmail: camp.bundle.recipientEmail, notionPageId },
      secret,
      cfg.mail.open_tracking_token_ttl_days * 86400,
    );
    bodyHtml = injectOpenPixel(
      bodyHtml,
      buildOpenPixelUrl({
        publicBaseUrl: publicBase,
        openPath: cfg.mail.open_tracking_path,
        token: openToken,
      }),
    );
  }

  await updatePage(notionPageId, {
    [cfg.notion.property_names.subject]: notionRichText(rendered.subject),
    [cfg.notion.property_names.body]: notionRichText(rendered.body),
  });

  await markSending(notionPageId);
  await sendMail({
    fromMailbox,
    to: [camp.bundle.recipientEmail],
    subject: rendered.subject,
    bodyHtml,
    isHtml: true,
    listUnsubscribeUrl,
  });

  let hit = null;
  for (let i = 0; i < 4 && !hit; i += 1) {
    await sleep(1000 + i * 1200);
    hit = await findRecentSentMessage(fromMailbox, rendered.subject, camp.bundle.recipientEmail).catch(
      () => null,
    );
  }
  if (!hit) {
    // Still mark success with placeholder ids if Sent Items lag — Graph accepted send
    await writeSendSuccess(notionPageId, {
      graphMessageId: "smoke-pending-sentitems",
      conversationId: "smoke-pending",
      internetMessageId: null,
      sentAt: new Date(),
    });
  } else {
    await writeSendSuccess(notionPageId, {
      graphMessageId: hit.graphMessageId,
      conversationId: hit.conversationId,
      internetMessageId: hit.internetMessageId,
      sentAt: new Date(hit.sentAt),
    });
  }

  return {
    to: camp.bundle.recipientEmail,
    from: fromMailbox,
    subject: rendered.subject,
    bodyPreview: rendered.body.slice(0, 180).replace(/\n/g, "\\n"),
    usedTemplate: rendered.usedTemplate,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.graph_apps_source === "db") await refreshGraphAppsFromDb();
  const stamp = Date.now();
  console.log("=== campaign internal smoke ===");

  const templates = await listCampaignTemplates({
    campaignKey: cfg.notion.campaign.campaign_key,
    activeOnly: true,
    channel: "Email",
  });
  const dtc1 = templates.find((t) => t.productLine === "DTC" && t.stepIndex === 1);
  const asin1 = templates.find((t) => t.productLine === "ASIN_Plus" && t.stepIndex === 1);
  if (!dtc1 || !asin1) throw new Error("missing DTC/ASIN step-1 templates");

  const clientPageId = await pickSmokeClientPageId();
  console.log("clientPageId", clientPageId);

  const kpDtc = await createSmokeKeyPerson({
    name: `[SMOKE] Ella ${stamp}`,
    email: TO_DTC,
    clientPageId,
  });
  const kpAsin = await createSmokeKeyPerson({
    name: `[SMOKE] Billy ${stamp}`,
    email: TO_ASIN,
    clientPageId,
  });
  console.log("created smoke KPs", { kpDtc, kpAsin });

  const histDtc = await createHistoryTodo({
    taskId: `smoke_campaign_flow:dtc1:${stamp}`,
    productLine: "DTC",
    stepIndex: 1,
    templatePageId: dtc1.pageId,
    clientPageId,
    keyPersonPageId: kpDtc,
    fromMailbox: FROM_DTC,
  });
  const histAsin = await createHistoryTodo({
    taskId: `smoke_campaign_flow:asin1:${stamp}`,
    productLine: "ASIN_Plus",
    stepIndex: 1,
    templatePageId: asin1.pageId,
    clientPageId,
    keyPersonPageId: kpAsin,
    fromMailbox: FROM_ASIN,
  });
  console.log("created history", { histDtc, histAsin });

  console.log("\n[DTC Email 1] sending...");
  const r1 = await sendHistoryPage(histDtc);
  console.log(r1);

  console.log("\n[ASIN Plus Email 1] sending...");
  const r2 = await sendHistoryPage(histAsin);
  console.log(r2);

  console.log("\n=== DONE ===");
  console.log(
    JSON.stringify(
      {
        dtc: { historyPageId: histDtc, ...r1 },
        asin: { historyPageId: histAsin, ...r2 },
        checkInboxes: [TO_DTC, TO_ASIN],
        notionHistoryDb: cfg.notion.campaign.history_database_id,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
