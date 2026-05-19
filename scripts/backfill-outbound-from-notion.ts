/**
 * 一次性回填 `outbound_messages`（Supabase / Postgres）并同步 Notion 上的 CRM（Entity / KeyPerson）。
 *
 * ## 合理方案（摘要）
 *
 * 1. **事实来源（发信记录）**  
 *    系统在正常发信成功后会执行 `writeSendSuccess`，在 Outreach 数据库对应行的 **Payload** 里写入 `_graph`：
 *    `{ messageId, conversationId, internetMessageId, sentAt }`（见 `src/notion/writer.ts`）。  
 *    因此「历史上已成功发信」且当时跑过该逻辑的 Notion 行，**优先**用 **Outreach 库**（`NOTION_DATABASE_ID`）里
 *    **`Status = Success` 且 `Action` 为 Send Email 或 Reply Email**（取值来自 `NOTION_ACTION_SEND` / `NOTION_ACTION_REPLY`）的行 + 解析 Payload 来重建 `outbound_messages` 主键字段。
 *
 * 2. **Entity / KeyPerson 与 Interaction LOG 对齐**  
 *    - 若 CRM 字段在 **Outreach 行**上已填（`NOTION_COL_*` 与 `extractCrmFromNotionProperties` 一致），脚本会直接写入 PG。  
 *    - 若你另有 **Interaction LOG** 数据库，且其中每一行通过 **Relation** 指回对应的 Outreach 任务页，可配置：
 *      `NOTION_INTERACTION_LOG_DATABASE_ID` + `NOTION_IL_OUTREACH_RELATION_PROP`（IL 上指向 Outreach 的 relation 列名）。  
 *      脚本会先扫 IL 全库建立 `outreachPageId → CRM` 映射；处理 Outreach 行时 **用 IL 侧 CRM 覆盖/补全**（非空字段优先采用 IL）。
 *
 * 3. **幂等**  
 *    以 `(mailbox_id, graph_message_id)` 唯一键为准：已存在则 **UPDATE**（刷新 notion_page_id、subject、CRM、sent_at 等），不存在则 **INSERT**。
 *
 * 4. **无 `_graph` 的历史行（其它工具发信）**  
 *    若 Success 行 Payload 可解析 JSON 但无 `_graph`，则走 **legacy** 分支：  
 *    - 用 **FCAccount** → `mailboxes`；从 Payload **只**读 **`to_email`** 作为收件人（不写 `to` / `counterpartyEmail` 等）。  
 *    - 主题与正文以 Notion 列为准（`NOTION_COL_SUBJECT` / `NOTION_COL_BODY`，常见为 **Outreach Subject** / **Outreach Body**），与 Payload 内同名字段比对。  
 *    - **Subject / Body 比对**：Notion 列与 Payload 里的 `subject` / `email_subject`、`body` / `bodyHtml` 在规范化后需一致或互相包含（可用 `BACKFILL_LEGACY_RELAXED_COMPARE=1` 放宽主题匹配）。  
 *    - 写入时 **`graph_message_id` = `notion-legacy:<pageId>`**、**`conversation_id` = `notion-legacy-conv:<pageId>`**（占位，不参与真实 Graph 会话匹配；后续若该行被本系统重发并写入 `_graph`，会多一条真实 Graph 行，需运维自行合并/删 legacy）。  
 *    - **`sent_at`**：优先 Notion **Completion Time**，否则用页面 **`last_edited_time`**（若 API 未返回则用当前时间并记入 `meta_json`）。
 *
 * 5. **仍会跳过**  
 *    - Payload 非 JSON / **无 `to_email`**（legacy 分支）。  
 *    - FCAccount 在 `mailboxes` 无匹配。  
 *    - 启用了 subject/body 校验且 **明显不一致**（见跳过原因统计）。
 *
 * ## 运行
 *
 * ```bash
 * # 只统计将要写入/跳过的数量，不写库
 * DRY_RUN=1 npx tsx scripts/backfill-outbound-from-notion.ts
 *
 * # 实际写入（建议先在 staging DB 试跑）
 * npx tsx scripts/backfill-outbound-from-notion.ts
 * ```
 *
 * ## 可选环境变量（除常规 `.env` 外）
 *
 * - `NOTION_INTERACTION_LOG_DATABASE_ID` — Interaction LOG 的 Notion database id（32 位，可有连字符）
 * - `NOTION_IL_OUTREACH_RELATION_PROP` — IL 数据库中 **Relation 列名**，指向 Outreach 任务页（多选则取第一个）
 * - `BACKFILL_LEGACY_RELAXED_COMPARE=1` — 主题比对允许「互相包含」而非整串相等
 * - `BACKFILL_CRM_FROM_PAYLOAD=1` — 当 Notion CRM 列为空时，从 Payload JSON 读取  
 *   `key_person_id` / `keyPersonId`、`entity_name` / `entityName` 等同义字段补全（见脚本内 `mergeCrmFromPayloadIfEnabled`）。
 * - `BACKFILL_LEGACY_RESOLVE_GRAPH=1` — 对无 `_graph` 的 legacy 行，用 **发件邮箱** 调 Graph **已发送**，尝试解析真实 `messageId` / `conversationId` / `internetMessageId`（见 `findSentMessageNearDate`）。
 * - `BACKFILL_LEGACY_SKIP_SUBJECT_BODY=1` — **不推荐**：仅校验收件人，不做 Subject/Body 比对
 * - `BACKFILL_GRAPH_SEARCH_WINDOW_HOURS` — 以 Notion **Completion 时间**为中心，在 **每侧** 多少小时内查 Graph 已发送（总跨度约 2×）；**设为 `0` 表示不按时间过滤**，从新到旧分页扫 **最多** `BACKFILL_GRAPH_SENT_SCAN_MAX` 封（默认 5000），仍要求 **主题 + to_email 与 Sent Items 完全一致**（Graph 无法一次枚举邮箱里「全部历史」）。
 * - `BACKFILL_GRAPH_SENT_SCAN_MAX` — 当 `BACKFILL_GRAPH_SEARCH_WINDOW_HOURS=0` 时：最多读取多少封已发送邮件再停（防止无限分页）。
 */

import { and, eq } from "drizzle-orm";
import { loadConfig } from "../src/config/index.js";
import { db, pool } from "../src/db/client.js";
import { outboundMessages } from "../src/db/schema/outbound_messages.js";
import { listAllMailboxes } from "../src/db/repositories/mailbox.repo.js";
import { findSentMessageNearDate } from "../src/graph/mail.service.js";
import { extractCrmFromNotionProperties, type CrmSnapshot } from "../src/notion/crm-snapshot.js";
import { queryDatabase, retrieveDatabase, hyphenateId, type NotionPage } from "../src/notion/client.js";
import {
  buildPropertyResolver,
  normalizeEmail,
  readDateStart,
  readRichText,
  richTextPropertyToHtml,
} from "../src/notion/property-mapper.js";

function normPageId(id: string): string {
  return String(id ?? "").replace(/-/g, "");
}

function readPropPlain(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const o = prop as Record<string, unknown>;
  const t = o.type;
  if (t === "title") {
    const arr = o.title as Array<{ plain_text?: string }> | undefined;
    return (arr?.map((x) => x.plain_text).join("") ?? "").trim();
  }
  if (t === "rich_text") {
    const arr = o.rich_text as Array<{ plain_text?: string }> | undefined;
    return (arr?.map((x) => x.plain_text).join("") ?? "").trim();
  }
  if (t === "url") return String(o.url ?? "").trim();
  if (t === "email") return String(o.email ?? "").trim();
  if (t === "unique_id") {
    const u = o.unique_id as { prefix?: string; number?: number } | undefined;
    if (u?.prefix != null && u.number != null) return `${u.prefix}-${u.number}`;
    return "";
  }
  if (t === "select") return String((o.select as { name?: string } | null)?.name ?? "").trim();
  if (t === "status") return String((o.status as { name?: string } | null)?.name ?? "").trim();
  return "";
}

function readRelationTargetIds(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const o = prop as Record<string, unknown>;
  if (o.type !== "relation") return [];
  const arr = o.relation as Array<{ id?: string }> | undefined;
  return (arr ?? []).map((r) => hyphenateId(String(r.id ?? ""))).filter(Boolean);
}

function parsePayloadJson(
  properties: Record<string, unknown>,
  pick: ReturnType<typeof buildPropertyResolver>["pick"],
): Record<string, unknown> | null {
  const payloadProp = pick(properties, "payload") as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  const raw = payloadProp?.rich_text?.[0]?.plain_text ?? "";
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractGraphFromParsed(parsed: Record<string, unknown>): {
  messageId: string;
  conversationId: string;
  internetMessageId: string | null;
  sentAt: Date;
} | null {
  const g = parsed._graph as Record<string, unknown> | undefined;
  if (!g || typeof g !== "object") return null;
  const messageId = String(g.messageId ?? "").trim();
  const conversationId = String(g.conversationId ?? "").trim();
  if (!messageId || !conversationId) return null;
  const internetMessageId = g.internetMessageId != null ? String(g.internetMessageId) : null;
  const sentRaw = String(g.sentAt ?? "").trim();
  const sentAt = sentRaw ? new Date(sentRaw) : new Date(NaN);
  if (Number.isNaN(sentAt.getTime())) return null;
  return { messageId, conversationId, internetMessageId, sentAt };
}

const LEGACY_MSG_PREFIX = "notion-legacy:";
const LEGACY_CONV_PREFIX = "notion-legacy-conv:";

function normCompare(s: string): string {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripHtmlLoose(html: string): string {
  return normCompare(String(html ?? "").replace(/<[^>]+>/g, " "));
}

/** Backfill：Payload 内收件人**仅**使用 `to_email`（与队列消费逻辑 `buildSendJobFromNotion` 可不同）。 */
function extractToEmailOnly(parsed: Record<string, unknown>): string {
  if (parsed.to_email == null || parsed.to_email === "") return "";
  const e = normalizeEmail(String(parsed.to_email));
  return e && /@/.test(e) ? e : "";
}

function payloadSubjectHint(parsed: Record<string, unknown>): string {
  const a = parsed.subject;
  const b = parsed.email_subject ?? parsed.emailSubject;
  if (typeof a === "string" && a.trim()) return a;
  if (typeof b === "string" && b.trim()) return b;
  return "";
}

function payloadBodyPlain(parsed: Record<string, unknown>): string {
  const raw =
    (typeof parsed.bodyHtml === "string" && parsed.bodyHtml) ||
    (typeof parsed.body === "string" && parsed.body) ||
    (typeof parsed.html === "string" && parsed.html) ||
    "";
  return stripHtmlLoose(raw);
}

function legacyPayloadMatchesNotion(
  notionSubject: string,
  notionBodyHtml: string,
  parsed: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (process.env.BACKFILL_LEGACY_SKIP_SUBJECT_BODY === "1" || process.env.BACKFILL_LEGACY_SKIP_SUBJECT_BODY === "true") {
    return { ok: true };
  }

  const relaxed = process.env.BACKFILL_LEGACY_RELAXED_COMPARE === "1" || process.env.BACKFILL_LEGACY_RELAXED_COMPARE === "true";

  const pSub = payloadSubjectHint(parsed);
  const nSub = normCompare(notionSubject);
  if (pSub && nSub) {
    const a = normCompare(pSub);
    if (a === nSub) {
      /* ok */
    } else if (relaxed && (a.includes(nSub) || nSub.includes(a))) {
      /* ok */
    } else if (!relaxed && a !== nSub) {
      return { ok: false, reason: "legacy_subject_mismatch" };
    } else if (relaxed && !(a.includes(nSub) || nSub.includes(a))) {
      return { ok: false, reason: "legacy_subject_mismatch_relaxed" };
    }
  }

  const pBody = payloadBodyPlain(parsed);
  const notionPlain = stripHtmlLoose(notionBodyHtml);
  const minLen = 50;
  if (pBody.length >= minLen && notionPlain.length >= minLen) {
    const shorter = pBody.length <= notionPlain.length ? pBody : notionPlain;
    const longer = pBody.length > notionPlain.length ? pBody : notionPlain;
    const prefixLen = relaxed ? 40 : 100;
    const prefix = shorter.slice(0, Math.min(prefixLen, shorter.length));
    if (!longer.includes(prefix)) {
      return { ok: false, reason: "legacy_body_mismatch" };
    }
  }

  return { ok: true };
}

function resolveLegacySentAt(page: NotionPage, pick: ReturnType<typeof buildPropertyResolver>["pick"]): Date {
  const completion = readDateStart(pick(page.properties, "completion_time"));
  if (completion) {
    const d = new Date(completion);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const led = (page as { last_edited_time?: string }).last_edited_time;
  if (led) {
    const d = new Date(led);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** 本脚本写入 `recipients_json`：仅来自 Payload 的 `to_email`（无则 `to` 为空数组）。 */
function recipientsFromParsed(parsed: Record<string, unknown>): { to: string[]; cc: string[]; bcc: string[] } {
  const one = extractToEmailOnly(parsed);
  return one ? { to: [one], cc: [], bcc: [] } : { to: [], cc: [], bcc: [] };
}

/** Outreach Body（HTML）优先；否则 Payload 的 bodyHtml / body / html。 */
function extractOutboundBody(
  properties: Record<string, unknown>,
  pick: ReturnType<typeof buildPropertyResolver>["pick"],
  parsed: Record<string, unknown>,
): string {
  const bodyProp = pick(properties, "body") as {
    type?: string;
    rich_text?: Array<{ plain_text?: string }>;
  };
  const fromNotion =
    bodyProp?.type === "rich_text" ? richTextPropertyToHtml(bodyProp as never) : readRichText(bodyProp);
  if (fromNotion.trim()) return fromNotion;
  const fromPayload =
    (typeof parsed.bodyHtml === "string" && parsed.bodyHtml) ||
    (typeof parsed.body === "string" && parsed.body) ||
    (typeof parsed.html === "string" && parsed.html) ||
    "";
  return fromPayload;
}

function mergeCrm(base: CrmSnapshot, overlay: CrmSnapshot | undefined): CrmSnapshot {
  if (!overlay) return base;
  const pick = (o: string | null, b: string | null) => (o && o.trim() ? o : b);
  return {
    keyPersonId: pick(overlay.keyPersonId, base.keyPersonId),
    keyPersonName: pick(overlay.keyPersonName, base.keyPersonName),
    keyPersonNotionUrl: pick(overlay.keyPersonNotionUrl, base.keyPersonNotionUrl),
    entityName: pick(overlay.entityName, base.entityName),
    entityNotionUrl: pick(overlay.entityNotionUrl, base.entityNotionUrl),
  };
}

/** 当 `BACKFILL_CRM_FROM_PAYLOAD=1` 时，用 Payload 中常见键补 Notion/IL 仍为空的 CRM 字段。 */
function mergeCrmFromPayloadIfEnabled(parsed: Record<string, unknown>, crm: CrmSnapshot): CrmSnapshot {
  if (process.env.BACKFILL_CRM_FROM_PAYLOAD !== "1" && process.env.BACKFILL_CRM_FROM_PAYLOAD !== "true") {
    return crm;
  }
  const g = (a: string, b: string): string | null => {
    for (const k of [a, b]) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const pick = (n: string | null, a: string, b: string) => (n && String(n).trim() ? n : g(a, b));
  return {
    keyPersonId: pick(crm.keyPersonId, "key_person_id", "keyPersonId"),
    keyPersonName: pick(crm.keyPersonName, "key_person_name", "keyPersonName"),
    keyPersonNotionUrl: pick(crm.keyPersonNotionUrl, "key_person_notion_url", "keyPersonNotionUrl"),
    entityName: pick(crm.entityName, "entity_name", "entityName"),
    entityNotionUrl: pick(crm.entityNotionUrl, "entity_notion_url", "entityNotionUrl"),
  };
}

let propertyTypesCache: Record<string, string> | null = null;
async function notionColumnTypes(databaseId: string): Promise<Record<string, string>> {
  if (propertyTypesCache) return propertyTypesCache;
  const dbMeta = await retrieveDatabase(databaseId);
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(dbMeta.properties)) {
    out[name] = (def as { type?: string }).type ?? "";
  }
  propertyTypesCache = out;
  return out;
}

function statusSuccessFilter(cfg: ReturnType<typeof loadConfig>, types: Record<string, string>): unknown {
  const col = cfg.notion.property_names.Status;
  const val = cfg.notion.status_values.success;
  const t = types[col];
  if (t === "status") return { property: col, status: { equals: val } };
  return { property: col, select: { equals: val } };
}

/** Action = Send Email 或 Reply Email（列类型 status / select 与数据库一致）。 */
function actionSendOrReplyFilter(cfg: ReturnType<typeof loadConfig>, types: Record<string, string>): unknown {
  const col = cfg.notion.property_names.Action;
  const send = cfg.notion.action_values.send;
  const reply = cfg.notion.action_values.reply;
  const t = types[col];
  const branch = (val: string): unknown =>
    t === "status" ? { property: col, status: { equals: val } } : { property: col, select: { equals: val } };
  return { or: [branch(send), branch(reply)] };
}

function successAndSendOrReplyFilter(cfg: ReturnType<typeof loadConfig>, types: Record<string, string>): unknown {
  return {
    and: [statusSuccessFilter(cfg, types), actionSendOrReplyFilter(cfg, types)],
  };
}

async function loadIlCrmByOutreachPageId(cfg: ReturnType<typeof loadConfig>): Promise<Map<string, CrmSnapshot>> {
  const map = new Map<string, CrmSnapshot>();
  const ilDb = process.env.NOTION_INTERACTION_LOG_DATABASE_ID?.trim();
  const linkProp = process.env.NOTION_IL_OUTREACH_RELATION_PROP?.trim();
  if (!ilDb || !linkProp) {
    console.log("[IL] 未配置 NOTION_INTERACTION_LOG_DATABASE_ID / NOTION_IL_OUTREACH_RELATION_PROP，跳过 IL 映射。");
    return map;
  }

  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const res = await queryDatabase(ilDb, { pageSize: 50, startCursor: cursor });
    for (const page of res.results) {
      if (page.archived) continue;
      const targets = readRelationTargetIds(page.properties[linkProp]);
      if (!targets.length) continue;
      const crm = extractCrmFromNotionProperties(cfg, page.properties);
      for (const oid of targets) {
        map.set(normPageId(oid), crm);
      }
      total += 1;
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor ?? undefined;
  }
  console.log(`[IL] 已索引 ${map.size} 个 Outreach 页面 id 的 CRM 覆盖（来自 ${total} 条 IL 行）。`);
  return map;
}

async function upsertOutbound(row: typeof outboundMessages.$inferInsert): Promise<"insert" | "update"> {
  let hitId: number | undefined;

  if (row.notionPageId) {
    const [byPage] = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.mailboxId, row.mailboxId!), eq(outboundMessages.notionPageId, row.notionPageId)))
      .limit(1);
    if (byPage) hitId = byPage.id;
  }
  if (hitId == null) {
    const [byGraph] = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.mailboxId, row.mailboxId!), eq(outboundMessages.graphMessageId, row.graphMessageId!)))
      .limit(1);
    if (byGraph) hitId = byGraph.id;
  }

  if (hitId != null) {
    await db
      .update(outboundMessages)
      .set({
        notionPageId: row.notionPageId,
        graphMessageId: row.graphMessageId,
        internetMessageId: row.internetMessageId,
        conversationId: row.conversationId!,
        subject: row.subject,
        body: row.body,
        sentAt: row.sentAt!,
        recipientsJson: row.recipientsJson,
        metaJson: row.metaJson,
        threadStatus: row.threadStatus,
        keyPersonId: row.keyPersonId,
        keyPersonName: row.keyPersonName,
        keyPersonNotionUrl: row.keyPersonNotionUrl,
        entityName: row.entityName,
        entityNotionUrl: row.entityNotionUrl,
        updatedAt: new Date(),
      })
      .where(eq(outboundMessages.id, hitId));
    return "update";
  }

  await db.insert(outboundMessages).values(row);
  return "insert";
}

async function patchOutboundBodyOnly(
  mailboxId: number,
  notionPageId: string,
  body: string,
  dry: boolean,
): Promise<"updated" | "miss"> {
  const [hit] = await db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.mailboxId, mailboxId), eq(outboundMessages.notionPageId, notionPageId)))
    .limit(1);
  if (!hit) return "miss";
  if (!dry) {
    await db.update(outboundMessages).set({ body, updatedAt: new Date() }).where(eq(outboundMessages.id, hit.id));
  }
  return "updated";
}

async function main(): Promise<void> {
  const dry = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const bodyOnly = process.env.BACKFILL_BODY_ONLY === "1" || process.env.BACKFILL_BODY_ONLY === "true";
  const cfg = loadConfig();
  const { pick } = buildPropertyResolver(cfg);

  console.log(
    bodyOnly
      ? "[backfill:outbound] BACKFILL_BODY_ONLY=1：仅按 Notion Success 行更新 PG 中已有 outbound 的 body 列（Outreach Body / Payload）。"
      : "[backfill:outbound] 查询条件：Status=Success 且 Action=Send Email 或 Reply Email（见 NOTION_ACTION_*）。Payload 收件人仅 to_email；主题/正文来自 NOTION_COL_SUBJECT / NOTION_COL_BODY。",
  );

  const crmCols = cfg.notion.crm_columns;
  const allCrmEnvEmpty =
    !crmCols.key_person_id.trim() &&
    !crmCols.key_person_name.trim() &&
    !crmCols.key_person_url.trim() &&
    !crmCols.entity_name.trim() &&
    !crmCols.entity_url.trim();
  const payloadCrm = process.env.BACKFILL_CRM_FROM_PAYLOAD === "1" || process.env.BACKFILL_CRM_FROM_PAYLOAD === "true";
  if (allCrmEnvEmpty && !payloadCrm) {
    console.warn(
      "[CRM] NOTION_COL_KEYPERSON_* / NOTION_COL_ENTITY_* 均未配置，且未设置 BACKFILL_CRM_FROM_PAYLOAD=1：outbound 的 KP/Entity 列将为空（除非 Interaction LOG 映射有值）。请在 .env 填写与 Notion 列名一致的变量，或开启 Payload 回退。",
    );
  } else if (payloadCrm) {
    console.log("[CRM] 已启用 BACKFILL_CRM_FROM_PAYLOAD=1：Notion/IL 为空的字段将从 Payload JSON 同名键补充。");
  }

  const graphResolve =
    process.env.BACKFILL_LEGACY_RESOLVE_GRAPH === "1" || process.env.BACKFILL_LEGACY_RESOLVE_GRAPH === "true";
  if (graphResolve) {
    const wh = parseInt(process.env.BACKFILL_GRAPH_SEARCH_WINDOW_HOURS || "72", 10) || 72;
    const maxScan = parseInt(process.env.BACKFILL_GRAPH_SENT_SCAN_MAX || "5000", 10) || 5000;
    console.log(
      `[Graph] 已启用 BACKFILL_LEGACY_RESOLVE_GRAPH=1：legacy 行用发件邮箱调 Graph 已发送邮件；` +
        (wh <= 0
          ? `BACKFILL_GRAPH_SEARCH_WINDOW_HOURS=0（不按时间过滤），最多扫描 ${maxScan} 封（从新到旧），主题+to_email 须与邮箱中完全一致。`
          : `Completion 时间 ±${wh} 小时内按主题+to_email 匹配；未命中可改大窗口或设 0 + 调大 BACKFILL_GRAPH_SENT_SCAN_MAX。`),
    );
  }
  const mailboxes = await listAllMailboxes();
  const byEmail = new Map<string, (typeof mailboxes)[0]>();
  for (const m of mailboxes) {
    byEmail.set(m.email.trim().toLowerCase(), m);
  }

  const ilMap = await loadIlCrmByOutreachPageId(cfg);
  const types = await notionColumnTypes(cfg.notion.database_id);
  const filter = successAndSendOrReplyFilter(cfg, types);

  const startCursorEnv = process.env.BACKFILL_NOTION_START_CURSOR?.trim();
  let cursor: string | undefined = startCursorEnv || undefined;
  if (cursor) {
    console.log(`[backfill] 从 BACKFILL_NOTION_START_CURSOR 续跑: ${cursor.slice(0, 20)}…`);
  }
  const pageSize = Math.min(100, Math.max(1, parseInt(process.env.BACKFILL_NOTION_PAGE_SIZE || "25", 10) || 25));
  let scanned = 0;
  let inserted = 0;
  let updated = 0;
  let wouldApply = 0;
  let wouldGraph = 0;
  let wouldLegacy = 0;
  let skipped = 0;
  let legacySentItemsHits = 0;
  let legacySentItemsMiss = 0;
  let bodyOnlyUpdated = 0;
  let bodyOnlyMiss = 0;
  const skipReasons: Record<string, number> = {};

  const bump = (reason: string) => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    skipped += 1;
  };

  for (;;) {
    let res: Awaited<ReturnType<typeof queryDatabase>>;
    try {
      res = await queryDatabase(cfg.notion.database_id, {
        pageSize,
        startCursor: cursor,
        filter,
      });
    } catch (e) {
      console.error(`[backfill] Notion query 失败（已处理 ${scanned} 行）。`);
      if (cursor) {
        console.error(`[backfill] 从当前分页重试: BACKFILL_NOTION_START_CURSOR=${cursor}`);
      } else {
        console.error("[backfill] 从头重试即可；若多次 504，可设 BACKFILL_NOTION_PAGE_SIZE=15 降低每页条数。");
      }
      throw e;
    }

    for (const page of res.results as NotionPage[]) {
      scanned += 1;
      const pageId = hyphenateId(page.id);
      const parsed = parsePayloadJson(page.properties, pick);
      if (!parsed) {
        bump("invalid_or_empty_payload");
        continue;
      }

      const senderProp = pick(page.properties, "sender_email");
      const senderRaw = readPropPlain(senderProp).trim();
      const sender = senderRaw.toLowerCase();
      if (!sender) {
        bump("no_sender");
        continue;
      }
      const mb = byEmail.get(sender);
      if (!mb) {
        bump("mailbox_not_found");
        continue;
      }

      const graph = extractGraphFromParsed(parsed);
      const rpc = recipientsFromParsed(parsed);
      let recipientsJson: Record<string, unknown> =
        rpc.to.length || rpc.cc.length || rpc.bcc.length ? { ...rpc } : { to: [], cc: [], bcc: [] };

      const subjectCol = pick(page.properties, "subject");
      const subject = readRichText(subjectCol) || readPropPlain(subjectCol) || "(no subject)";
      const body = extractOutboundBody(page.properties, pick, parsed);

      if (bodyOnly) {
        const op = await patchOutboundBodyOnly(mb.id, pageId, body, dry);
        if (op === "updated") bodyOnlyUpdated += 1;
        else bodyOnlyMiss += 1;
        continue;
      }

      const baseCrm = extractCrmFromNotionProperties(cfg, page.properties);
      const ilCrm = ilMap.get(normPageId(pageId));
      const crm = mergeCrmFromPayloadIfEnabled(parsed, mergeCrm(baseCrm, ilCrm));

      let graphMessageId: string;
      let conversationId: string;
      let internetMessageId: string | null;
      let sentAt: Date;
      let metaJson: typeof outboundMessages.$inferInsert["metaJson"];

      if (graph) {
        graphMessageId = graph.messageId;
        conversationId = graph.conversationId;
        internetMessageId = graph.internetMessageId;
        sentAt = graph.sentAt;
        metaJson = {
          actionType: "notion_backfill",
          source: "scripts/backfill-outbound-from-notion",
          hasGraph: true,
        } as typeof outboundMessages.$inferInsert["metaJson"];
      } else {
        const primaryTo = extractToEmailOnly(parsed);
        if (!primaryTo) {
          bump("legacy_no_to_email");
          continue;
        }
        const bodyProp = pick(page.properties, "body") as {
          type?: string;
          rich_text?: Array<{ plain_text?: string }>;
        };
        const notionBodyHtml =
          bodyProp?.type === "rich_text" ? richTextPropertyToHtml(bodyProp as never) : readRichText(bodyProp);
        const notionSubject = readRichText(subjectCol) || readPropPlain(subjectCol);
        const match = legacyPayloadMatchesNotion(notionSubject, notionBodyHtml, parsed);
        if (!match.ok) {
          bump(match.reason);
          continue;
        }
        const anchorSentAt = resolveLegacySentAt(page, pick);
        const graphMailbox = mb.email.trim();
        let graphResolved: Awaited<ReturnType<typeof findSentMessageNearDate>> = null;
        if (graphResolve && !dry) {
          const windowH = parseInt(process.env.BACKFILL_GRAPH_SEARCH_WINDOW_HOURS || "72", 10) || 72;
          const maxScan = parseInt(process.env.BACKFILL_GRAPH_SENT_SCAN_MAX || "5000", 10) || 5000;
          try {
            graphResolved = await findSentMessageNearDate(graphMailbox, subject, primaryTo, anchorSentAt, {
              windowHours: windowH,
              maxMessagesToScan: maxScan,
            });
          } catch (e) {
            console.warn(`[Graph] page ${pageId} findSentMessageNearDate failed:`, e);
          }
        }

        if (graphResolved) {
          graphMessageId = graphResolved.graphMessageId;
          conversationId = graphResolved.conversationId;
          internetMessageId = graphResolved.internetMessageId;
          sentAt = new Date(graphResolved.sentAt);
          legacySentItemsHits += 1;
          metaJson = {
            actionType: "notion_backfill",
            source: "scripts/backfill-outbound-from-notion",
            legacyNoGraph: true,
            resolvedFromSentItems: true,
            primaryTo,
          } as typeof outboundMessages.$inferInsert["metaJson"];
        } else {
          if (graphResolve && !dry) legacySentItemsMiss += 1;
          const pid = normPageId(pageId);
          graphMessageId = `${LEGACY_MSG_PREFIX}${pid}`;
          conversationId = `${LEGACY_CONV_PREFIX}${pid}`;
          internetMessageId = null;
          sentAt = anchorSentAt;
          metaJson = {
            actionType: "notion_backfill",
            source: "scripts/backfill-outbound-from-notion",
            legacyNoGraph: true,
            syntheticIds: true,
            primaryTo,
          } as typeof outboundMessages.$inferInsert["metaJson"];
        }
      }

      const row: typeof outboundMessages.$inferInsert = {
        mailboxId: mb.id,
        notionPageId: pageId,
        graphMessageId,
        internetMessageId,
        conversationId,
        subject,
        body,
        sentAt,
        recipientsJson: recipientsJson as typeof outboundMessages.$inferInsert["recipientsJson"],
        metaJson,
        threadStatus: "sent",
        keyPersonId: crm.keyPersonId,
        keyPersonName: crm.keyPersonName,
        keyPersonNotionUrl: crm.keyPersonNotionUrl,
        entityName: crm.entityName,
        entityNotionUrl: crm.entityNotionUrl,
      };

      if (dry) {
        wouldApply += 1;
        if (graph) wouldGraph += 1;
        else wouldLegacy += 1;
        continue;
      }

      const op = await upsertOutbound(row);
      if (op === "insert") inserted += 1;
      else if (op === "update") updated += 1;
    }

    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor ?? undefined;
    if (cursor && scanned > 0 && scanned % 500 === 0) {
      console.log(`[backfill] 进度 ${scanned} 行；续跑: BACKFILL_NOTION_START_CURSOR=${cursor}`);
    }
  }

  console.log(
    bodyOnly
      ? dry
        ? `[DRY_RUN] 扫描 Success 行: ${scanned}，将更新 body: ${bodyOnlyUpdated}，PG 无对应 outbound: ${bodyOnlyMiss}`
        : `完成（仅 body）。扫描: ${scanned}，已更新 body: ${bodyOnlyUpdated}，无匹配 outbound 行: ${bodyOnlyMiss}`
      : dry
        ? `[DRY_RUN] 扫描 Success 行: ${scanned}，可写入/更新: ${wouldApply}（含 Graph: ${wouldGraph}，无 Graph legacy: ${wouldLegacy}），跳过: ${skipped}`
        : `完成。扫描: ${scanned}，新增: ${inserted}，更新: ${updated}，跳过: ${skipped}`,
  );
  if (skipped > 0) {
    console.log("跳过原因统计:", skipReasons);
  }
  if (graphResolve && !dry) {
    console.log(
      `[Graph] Sent Items 解析：命中 ${legacySentItemsHits}，未命中 ${legacySentItemsMiss}（未命中仍写入 notion-legacy 占位）。`,
    );
  } else if (graphResolve && dry) {
    console.log("[Graph] DRY_RUN 未调用 Graph；正式去掉 DRY_RUN 且开启 BACKFILL_LEGACY_RESOLVE_GRAPH 时才会解析 Sent Items。");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() =>
    pool.end().catch(() => {
      /* ignore */
    }),
  );
