/**
 * 拉取一条 Interaction LOG 行（及 Relation 指向的 Key Person / Entity 页），
 * 打印各属性 **列名 + 类型 + 摘要**，便于配置 `NOTION_IL_SYNC_*` 与确认同步逻辑。
 *
 * ```bash
 * npx tsx scripts/debug-notion-il-crm-sample.ts
 * # 或指定 IL page id（可有连字符）
 * DEBUG_IL_PAGE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx npx tsx scripts/debug-notion-il-crm-sample.ts
 * ```
 *
 * 依赖：`.env` 中 `NOTION_TOKEN`；可选 `DATABASE_URL` 从 `outbound_messages` 取第一条 `notion_page_id`。
 */

import { desc, isNotNull } from "drizzle-orm";
import { loadConfig } from "../src/config/index.js";
import { db, pool } from "../src/db/client.js";
import { outboundMessages } from "../src/db/schema/outbound_messages.js";
import { getPage, hyphenateId, type NotionPage } from "../src/notion/client.js";
import { readFormulaText, readRichText } from "../src/notion/property-mapper.js";

function summarizeProp(prop: unknown): { type: string; preview: string } {
  if (!prop || typeof prop !== "object") return { type: "?", preview: "" };
  const o = prop as Record<string, unknown>;
  const t = String(o.type ?? "?");
  let preview = "";
  if (t === "title" || t === "rich_text") preview = readRichText(o as never).slice(0, 120);
  else if (t === "formula") preview = readFormulaText(o as never).slice(0, 120);
  else if (t === "url") preview = String(o.url ?? "").slice(0, 120);
  else if (t === "email") preview = String(o.email ?? "").slice(0, 120);
  else if (t === "phone_number") preview = String(o.phone_number ?? "").slice(0, 120);
  else if (t === "number" && o.number != null) preview = String(o.number);
  else if (t === "checkbox") preview = String(Boolean((o as { checkbox?: boolean }).checkbox));
  else if (t === "date") {
    const d = (o as { date?: { start?: string } }).date;
    preview = String(d?.start ?? "");
  } else if (t === "unique_id") {
    const u = o.unique_id as { prefix?: string; number?: number } | undefined;
    preview = u?.prefix != null && u?.number != null ? `${u.prefix}-${u.number}` : "";
  } else if (t === "select") preview = String((o.select as { name?: string } | null)?.name ?? "");
  else if (t === "status") preview = String((o.status as { name?: string } | null)?.name ?? "");
  else if (t === "multi_select") {
    const arr = (o as { multi_select?: Array<{ name?: string }> }).multi_select;
    preview = (arr ?? []).map((x) => x.name).filter(Boolean).join(", ").slice(0, 120);
  } else if (t === "people") {
    const arr = (o as { people?: Array<{ name?: string }> }).people;
    preview = (arr ?? []).map((x) => x.name).filter(Boolean).join(", ").slice(0, 120);
  } else if (t === "created_by" || t === "last_edited_by") preview = "(user)";
  else if (t === "last_edited_time") preview = String((o as { last_edited_time?: string }).last_edited_time ?? "").slice(0, 32);
  else if (t === "created_time") preview = String((o as { created_time?: string }).created_time ?? "").slice(0, 32);
  else if (t === "relation") {
    const arr = o.relation as Array<{ id?: string }> | undefined;
    preview = (arr ?? []).map((r) => hyphenateId(String(r.id ?? ""))).join(", ");
  } else if (t === "rollup") {
    const r = o.rollup as { type?: string; array?: unknown[]; number?: number; date?: { start?: string } } | undefined;
    if (r?.type === "array" && Array.isArray(r.array)) {
      const bits: string[] = [];
      for (const item of r.array) {
        if (item && typeof item === "object") {
          const it = item as { type?: string };
          if (it.type === "title" || it.type === "rich_text") bits.push(readRichText(item as never));
        }
      }
      preview = bits.join(" | ").slice(0, 120);
    } else if (r?.type === "number" && r.number != null) preview = String(r.number);
    else if (r?.type === "date" && r.date?.start) preview = String(r.date.start);
    else preview = JSON.stringify(r).slice(0, 120);
  } else preview = JSON.stringify(o).slice(0, 80);
  return { type: t, preview };
}

function printPage(label: string, page: NotionPage): void {
  console.log(`\n======== ${label} (id=${hyphenateId(page.id)}) ========`);
  const props = page.properties as Record<string, unknown>;
  const rows = Object.entries(props)
    .map(([name, p]) => {
      const { type, preview } = summarizeProp(p);
      return { name, type, preview };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const w = Math.max(...rows.map((r) => r.name.length), 10);
  for (const r of rows) {
    console.log(`${r.name.padEnd(w)}  ${r.type.padEnd(12)}  ${r.preview}`);
  }
}

function readRelationSingle(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const o = prop as Record<string, unknown>;
  if (o.type !== "relation") return null;
  const arr = o.relation as Array<{ id?: string }> | undefined;
  const id = arr?.[0]?.id;
  return id ? hyphenateId(String(id)) : null;
}

async function main(): Promise<void> {
  loadConfig();
  const kpRel = process.env.NOTION_IL_KP_RELATION?.trim() || "KeyPerson ID";
  const entRel = process.env.NOTION_IL_ENTITY_RELATION?.trim() || "Entity Name";

  let ilId = process.env.DEBUG_IL_PAGE_ID?.trim() ?? "";
  if (!ilId) {
    const [row] = await db
      .select({ notionPageId: outboundMessages.notionPageId })
      .from(outboundMessages)
      .where(isNotNull(outboundMessages.notionPageId))
      .orderBy(desc(outboundMessages.id))
      .limit(1);
    ilId = String(row?.notionPageId ?? "").trim();
  }

  if (!ilId) {
    console.error("无 DEBUG_IL_PAGE_ID 且 outbound_messages 没有 notion_page_id，无法取样。");
    process.exitCode = 1;
    return;
  }

  console.log(`[sample] IL page id: ${ilId}`);
  console.log(`[sample] Relation 列: "${kpRel}" / "${entRel}"`);

  const ilPage = await getPage(ilId);
  printPage("Interaction LOG 行", ilPage);

  const props = ilPage.properties as Record<string, unknown>;
  const kpId = readRelationSingle(props[kpRel]);
  const entId = readRelationSingle(props[entRel]);

  if (!kpId) console.warn(`\n[warn] 列 "${kpRel}" 无 relation 目标或列名不匹配。`);
  else {
    const p = await getPage(kpId);
    printPage("Key Person 关联页", p);
  }

  if (!entId) console.warn(`\n[warn] 列 "${entRel}" 无 relation 目标或列名不匹配。`);
  else {
    const p = await getPage(entId);
    printPage("Entity 关联页", p);
  }

  console.log(
    "\n[hint] 若 Key Person 的「业务 ID」在某列（非 Title），把列名设到 NOTION_IL_SYNC_KP_ID_PROP；" +
      "展示名在另一列则设 NOTION_IL_SYNC_KP_NAME_PROP。Entity 名称若不在 Title，设 NOTION_IL_SYNC_ENTITY_NAME_PROP。",
  );
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
