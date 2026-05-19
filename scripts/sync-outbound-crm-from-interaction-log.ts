/**
 * 根据 `outbound_messages.notion_page_id`（**Interaction LOG** 行的 Notion page id）
 * 补全 / 刷新 `key_person_*` 与 `entity_*` 列。
 *
 * ## 数据关系（请与你的 Notion 表核对）
 *
 * 1. **PG `notion_page_id`** = Interaction LOG 数据库里某一行的 **page id**（与 Outbound 页「Notion」列打开的链接一致）。
 * 2. **IL 行**上有两列 **Relation**（列名由环境变量指定；每条 IL 数据上为 **0 或 1 个** 关联）：
 *    - `NOTION_IL_KP_RELATION` → **Key Person** 页。
 *    - `NOTION_IL_ENTITY_RELATION` → **Entity** 页。
 * 3. **Key Person 页** → `key_person_id` / `key_person_name` / `key_person_notion_url`：
 *    - URL 固定为 `https://www.notion.so/<32位hex无连字符>`。
 *    - `key_person_id`：优先读 `NOTION_IL_SYNC_KP_ID_PROP` 指定列；未配置则尝试 **Unique ID**；再否则用 **Title** 纯文本。
 *    - `key_person_name`：优先读 `NOTION_IL_SYNC_KP_NAME_PROP`；未配置则用 Title。
 * 4. **Entity 页** → `entity_name` / `entity_notion_url`：
 *    - `entity_name`：优先读 `NOTION_IL_SYNC_ENTITY_NAME_PROP`；未配置则用 **Title**。
 *
 * ## 运行
 *
 * ```bash
 * # 只打印将更新多少条、不写库
 * DRY_RUN=1 npx tsx scripts/sync-outbound-crm-from-interaction-log.ts
 *
 * # 仅处理 CRM 仍缺口的行（默认）
 * npx tsx scripts/sync-outbound-crm-from-interaction-log.ts
 *
 * # 对已填 CRM 的行也重新从 Notion 拉一遍
 * SYNC_IL_CRM_OVERWRITE=1 npx tsx scripts/sync-outbound-crm-from-interaction-log.ts
 * ```
 *
 * ## 必填环境变量
 *
 * - `NOTION_IL_KP_RELATION` — IL 表上指向 Key Person 的 **Relation 列名**
 * - `NOTION_IL_ENTITY_RELATION` — IL 表上指向 Entity 的 **Relation 列名**
 *
 * ## 可选
 *
 * - `NOTION_INTERACTION_LOG_DATABASE_ID` — 若设置，会校验 `notion_page_id` 对应页的 `parent.database_id` 是否属于该库（防误填 Outreach id）
 * - `NOTION_IL_SYNC_KP_ID_PROP` / `NOTION_IL_SYNC_KP_NAME_PROP` / `NOTION_IL_SYNC_ENTITY_NAME_PROP` — 关联页上的列名
 * - `SYNC_IL_CRM_LIMIT` — 最多处理多少条（调试用）
 */

import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { loadConfig } from "../src/config/index.js";
import { db, pool } from "../src/db/client.js";
import { outboundMessages } from "../src/db/schema/outbound_messages.js";
import { getPage, hyphenateId, type NotionPage } from "../src/notion/client.js";
import { readFormulaText, readRichText } from "../src/notion/property-mapper.js";

function normPageId(id: string): string {
  return String(id ?? "").replace(/-/g, "").toLowerCase();
}

function notionPublicUrl(pageId: string): string {
  const compact = normPageId(pageId);
  return compact.length === 32 ? `https://www.notion.so/${compact}` : "";
}

function readRelationTargetIds(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const o = prop as Record<string, unknown>;
  if (o.type !== "relation") return [];
  const arr = o.relation as Array<{ id?: string }> | undefined;
  return (arr ?? []).map((r) => hyphenateId(String(r.id ?? ""))).filter(Boolean);
}

function readPlainFlexible(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "";
  const o = prop as Record<string, unknown>;
  const t = o.type;
  if (t === "title" || t === "rich_text") return readRichText(o as never);
  if (t === "formula") return readFormulaText(o as never);
  if (t === "url") return String(o.url ?? "").trim();
  if (t === "email") return String(o.email ?? "").trim();
  if (t === "phone_number") return String(o.phone_number ?? "").trim();
  if (t === "number" && o.number != null && Number.isFinite(Number(o.number))) return String(o.number).trim();
  if (t === "unique_id") {
    const u = o.unique_id as { prefix?: string; number?: number } | undefined;
    if (u?.prefix != null && u.number != null) return `${u.prefix}-${u.number}`;
    return "";
  }
  if (t === "select") return String((o.select as { name?: string } | null)?.name ?? "").trim();
  if (t === "status") return String((o.status as { name?: string } | null)?.name ?? "").trim();
  if (t === "multi_select") {
    const arr = (o as { multi_select?: Array<{ name?: string }> }).multi_select;
    return (arr ?? []).map((x) => x.name).filter(Boolean).join(", ").trim();
  }
  if (t === "rollup") {
    const r = o.rollup as { type?: string; array?: unknown[]; number?: number; date?: { start?: string } } | undefined;
    if (r?.type === "array" && Array.isArray(r.array)) {
      const bits: string[] = [];
      for (const item of r.array) {
        if (item && typeof item === "object") {
          const it = item as { type?: string };
          if (it.type === "title" || it.type === "rich_text") bits.push(readRichText(item as never));
        }
      }
      return bits.join(" ").trim();
    }
    if (r?.type === "number" && r.number != null) return String(r.number).trim();
    if (r?.type === "date" && r.date?.start) return String(r.date.start).trim();
  }
  return "";
}

function readTitleFromPage(properties: Record<string, unknown>): string {
  for (const p of Object.values(properties)) {
    if (p && typeof p === "object" && (p as { type?: string }).type === "title") {
      return readRichText(p as never);
    }
  }
  return "";
}

function firstRelationId(properties: Record<string, unknown>, col: string): string | null {
  const ids = readRelationTargetIds(properties[col]);
  return ids[0] ?? null;
}

function assertIlParent(page: NotionPage, ilDbId: string | undefined, rowId: number): boolean {
  if (!ilDbId) return true;
  const parent = (page as { parent?: { type?: string; database_id?: string } }).parent;
  if (parent?.type !== "database_id" || !parent.database_id) {
    console.warn(`[skip id=${rowId}] 页面无 database 父级，与 NOTION_INTERACTION_LOG_DATABASE_ID 校验跳过`);
    return false;
  }
  if (normPageId(parent.database_id) !== normPageId(ilDbId)) {
    console.warn(
      `[skip id=${rowId}] notion_page_id 所在库与 NOTION_INTERACTION_LOG_DATABASE_ID 不一致（` +
        `期望 ${hyphenateId(ilDbId)}，实际 ${parent.database_id}）。若你存的是 Outreach 任务 id，请勿跑本脚本或关闭该校验。`,
    );
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const dry = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const overwrite = process.env.SYNC_IL_CRM_OVERWRITE === "1" || process.env.SYNC_IL_CRM_OVERWRITE === "true";
  const kpRel = process.env.NOTION_IL_KP_RELATION?.trim();
  const entRel = process.env.NOTION_IL_ENTITY_RELATION?.trim();
  const ilDb = process.env.NOTION_INTERACTION_LOG_DATABASE_ID?.trim();
  const kpIdProp = process.env.NOTION_IL_SYNC_KP_ID_PROP?.trim() ?? "";
  const kpNameProp = process.env.NOTION_IL_SYNC_KP_NAME_PROP?.trim() ?? "";
  const entNameProp = process.env.NOTION_IL_SYNC_ENTITY_NAME_PROP?.trim() ?? "";
  const limit = Math.max(0, parseInt(process.env.SYNC_IL_CRM_LIMIT || "0", 10) || 0);

  loadConfig();

  if (!kpRel || !entRel) {
    console.error(
      "缺少必填环境变量：NOTION_IL_KP_RELATION、NOTION_IL_ENTITY_RELATION（IL 上两个 Relation 列的**显示名称**）。",
    );
    process.exitCode = 1;
    return;
  }

  const emptyText = (col: typeof outboundMessages.keyPersonId) => or(isNull(col), eq(col, ""));

  const baseCond = isNotNull(outboundMessages.notionPageId);
  const needFill = overwrite
    ? baseCond
    : and(
        baseCond,
        or(
          emptyText(outboundMessages.keyPersonId),
          emptyText(outboundMessages.keyPersonName),
          emptyText(outboundMessages.keyPersonNotionUrl),
          emptyText(outboundMessages.entityName),
          emptyText(outboundMessages.entityNotionUrl),
        ),
      );

  let q = db.select().from(outboundMessages).where(needFill).orderBy(outboundMessages.id);
  const candidates = limit > 0 ? await q.limit(limit) : await q;

  console.log(
    `[sync:outbound-crm-il] 待处理行数: ${candidates.length}（overwrite=${overwrite}，DRY_RUN=${dry}，` +
      `KP relation="${kpRel}"，Entity relation="${entRel}"）`,
  );

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of candidates) {
    const pageId = String(row.notionPageId ?? "").trim();
    if (!pageId) {
      skipped += 1;
      continue;
    }

    try {
      const ilPage = await getPage(pageId);
      if (ilPage.archived) {
        console.warn(`[skip id=${row.id}] IL 页已归档`);
        skipped += 1;
        continue;
      }
      if (!assertIlParent(ilPage, ilDb, row.id)) {
        skipped += 1;
        continue;
      }

      const props = ilPage.properties as Record<string, unknown>;
      const kpLink = firstRelationId(props, kpRel);
      const entLink = firstRelationId(props, entRel);

      const patch: {
        keyPersonId?: string | null;
        keyPersonName?: string | null;
        keyPersonNotionUrl?: string | null;
        entityName?: string | null;
        entityNotionUrl?: string | null;
        updatedAt: Date;
      } = { updatedAt: new Date() };

      if (kpLink) {
        const kpPage = await getPage(kpLink);
        const kpProps = kpPage.properties as Record<string, unknown>;
        const title = readTitleFromPage(kpProps);
        let kpId = kpIdProp ? readPlainFlexible(kpProps[kpIdProp]) : "";
        if (!kpId) {
          for (const p of Object.values(kpProps)) {
            if (p && typeof p === "object" && (p as { type?: string }).type === "unique_id") {
              kpId = readPlainFlexible(p);
              if (kpId) break;
            }
          }
        }
        if (!kpId) kpId = title;
        const kpName = kpNameProp ? readPlainFlexible(kpProps[kpNameProp]) : title || kpId;
        const kpUrl = notionPublicUrl(kpPage.id);
        if (kpId) patch.keyPersonId = kpId;
        if (kpName) patch.keyPersonName = kpName;
        if (kpUrl) patch.keyPersonNotionUrl = kpUrl;
      }

      if (entLink) {
        const entPage = await getPage(entLink);
        const entProps = entPage.properties as Record<string, unknown>;
        const title = readTitleFromPage(entProps);
        const name = entNameProp ? readPlainFlexible(entProps[entNameProp]) : title;
        const entUrl = notionPublicUrl(entPage.id);
        if (name) patch.entityName = name;
        if (entUrl) patch.entityNotionUrl = entUrl;
      }

      const keys = Object.keys(patch).filter((k) => k !== "updatedAt");
      if (keys.length === 0) {
        console.warn(`[skip id=${row.id}] IL 上未解析到任何 CRM（检查 relation 是否为空、列名是否匹配）`);
        skipped += 1;
        continue;
      }

      if (dry) {
        console.log(`[DRY_RUN id=${row.id}] 将写入:`, { ...patch, updatedAt: "(now)" });
        updated += 1;
        continue;
      }

      await db.update(outboundMessages).set(patch).where(eq(outboundMessages.id, row.id));
      updated += 1;
    } catch (e) {
      errors += 1;
      console.warn(`[error id=${row.id}] notion_page_id=${pageId}`, e);
    }
  }

  console.log(`完成。更新/预演: ${updated}，跳过: ${skipped}，错误: ${errors}`);
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
