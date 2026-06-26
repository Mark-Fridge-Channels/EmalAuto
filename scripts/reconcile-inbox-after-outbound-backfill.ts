/**
 * 在 `outbound_messages` 补全之后，把 Inbox 行与出站数据对齐。
 *
 * ## 步骤
 *
 * 1. **CRM 同步**（默认）：已有 `matched_outbound_id` 的行，从 outbound 刷新 5 个 CRM 列。
 * 2. **启发式关联**（默认，可用 `RECONCILE_HEURISTIC=0` 关闭）：对 `ignored`/`unmatched` 行，按
 *    mailbox + 规范化主题 + 收发人 + 时间窗 匹配 outbound（含 `notion-legacy` 占位行），
 *    写入 `matched_outbound_id`、`match_status=matched` 与 CRM；**不写 Notion**、不更新 `thread_status`。
 *    跑完后建议：`npm run sync:thread-status-from-inbox`（或重新入队 match，worker 会补写 status）。
 * 3. **conversation_id 入队**（需 `REQUEUE_MATCH_FOR_CONVERSATION=1`）：仅非 legacy 会话，走 match worker（可能写 Notion）。
 *
 * ## 运行
 *
 * ```bash
 * DRY_RUN=1 npm run reconcile:inbox
 * npm run reconcile:inbox
 * RECONCILE_HEURISTIC_RELAXED_SUBJECT=1 npm run reconcile:inbox
 * REQUEUE_MATCH_FOR_CONVERSATION=1 npm run reconcile:inbox
 * RECONCILE_HEURISTIC=0 npm run reconcile:inbox   # 仅 CRM + 可选 requeue
 * ```
 */

import { and, eq, notLike, or, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { inboxMessages } from "../src/db/schema/inbox_messages.js";
import { mailboxes } from "../src/db/schema/mailboxes.js";
import { outboundMessages } from "../src/db/schema/outbound_messages.js";
import { matchQueue } from "../src/queues/queues.js";
import { detectBounce } from "../src/services/bounce-detector.service.js";
import {
  normalizeThreadSubject,
  resolveLegacyOutboundMatch,
} from "../src/services/legacy-outbound-match.service.js";

type OutboundCandidate = {
  id: number;
  mailboxId: number;
  subject: string;
  sentAt: Date;
  recipientsJson: unknown;
  keyPersonId: string | null;
  keyPersonName: string | null;
  keyPersonNotionUrl: string | null;
  entityName: string | null;
  entityNotionUrl: string | null;
};

function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

function envEnabled(name: string, defaultOn: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultOn;
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  return defaultOn;
}

function crmPatchFromOutbound(o: OutboundCandidate) {
  return {
    keyPersonId: o.keyPersonId,
    keyPersonName: o.keyPersonName,
    keyPersonNotionUrl: o.keyPersonNotionUrl,
    entityName: o.entityName,
    entityNotionUrl: o.entityNotionUrl,
  };
}

async function countCrmSyncTargets(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(inboxMessages)
    .innerJoin(outboundMessages, eq(inboxMessages.matchedOutboundId, outboundMessages.id))
    .where(sql`${inboxMessages.matchedOutboundId} IS NOT NULL`);
  return rows[0]?.c ?? 0;
}

async function runCrmSync(dry: boolean): Promise<number> {
  if (dry) {
    const n = await countCrmSyncTargets();
    console.log(`[CRM] DRY_RUN：将有 matched_outbound_id 且能 JOIN 到 outbound 的 inbox 行约 ${n} 条（正式跑会执行 UPDATE）。`);
    return 0;
  }
  const res = await db.execute(sql`
    UPDATE inbox_messages AS i
    SET
      key_person_id = COALESCE(o.key_person_id, i.key_person_id),
      key_person_name = COALESCE(o.key_person_name, i.key_person_name),
      key_person_notion_url = COALESCE(o.key_person_notion_url, i.key_person_notion_url),
      entity_name = COALESCE(o.entity_name, i.entity_name),
      entity_notion_url = COALESCE(o.entity_notion_url, i.entity_notion_url)
    FROM outbound_messages AS o
    WHERE i.matched_outbound_id = o.id
      AND i.matched_outbound_id IS NOT NULL
  `);
  const n = (res as { rowCount?: number }).rowCount ?? 0;
  console.log(`[CRM] 已更新 inbox_messages 行数: ${n}（COALESCE：出站非空则覆盖）。`);
  return n;
}

interface HeuristicStats {
  scanned: number;
  matched: number;
  ambiguous: number;
  noCandidate: number;
  skippedBounce: number;
}

async function runHeuristicMatch(dry: boolean): Promise<HeuristicStats> {
  const stats: HeuristicStats = {
    scanned: 0,
    matched: 0,
    ambiguous: 0,
    noCandidate: 0,
    skippedBounce: 0,
  };

  if (!envEnabled("RECONCILE_HEURISTIC", true)) {
    console.log("[heuristic] RECONCILE_HEURISTIC=0，跳过启发式关联。");
    return stats;
  }

  const relaxedSubject = envTruthy("RECONCILE_HEURISTIC_RELAXED_SUBJECT");
  const maxDays = Math.max(0, parseInt(process.env.RECONCILE_HEURISTIC_MAX_DAYS || "365", 10) || 365);
  const maxAgeMs = maxDays > 0 ? maxDays * 86_400_000 : 0;

  const mboxRows = await db.select({ id: mailboxes.id, email: mailboxes.email }).from(mailboxes);
  const emailByMailboxId = new Map(mboxRows.map((m) => [m.id, m.email]));

  const inboxRows = await db
    .select()
    .from(inboxMessages)
    .where(
      and(
        or(eq(inboxMessages.matchStatus, "ignored"), eq(inboxMessages.matchStatus, "unmatched")),
        sql`${inboxMessages.matchedOutboundId} IS NULL`,
      ),
    );

  const outboundRows = await db
    .select({
      id: outboundMessages.id,
      mailboxId: outboundMessages.mailboxId,
      subject: outboundMessages.subject,
      sentAt: outboundMessages.sentAt,
      recipientsJson: outboundMessages.recipientsJson,
      keyPersonId: outboundMessages.keyPersonId,
      keyPersonName: outboundMessages.keyPersonName,
      keyPersonNotionUrl: outboundMessages.keyPersonNotionUrl,
      entityName: outboundMessages.entityName,
      entityNotionUrl: outboundMessages.entityNotionUrl,
    })
    .from(outboundMessages);

  const outboundByMailbox = new Map<number, OutboundCandidate[]>();
  for (const o of outboundRows) {
    const list = outboundByMailbox.get(o.mailboxId) ?? [];
    list.push(o);
    outboundByMailbox.set(o.mailboxId, list);
  }

  console.log(
    `[heuristic] 待扫描 inbox: ${inboxRows.length}，outbound: ${outboundRows.length}，` +
      `主题${relaxedSubject ? "宽松" : "严格"}匹配，时间窗 ${maxDays} 天，DRY_RUN=${dry ? "是" : "否"}。`,
  );

  for (const row of inboxRows) {
    stats.scanned += 1;

    const bounce = detectBounce({
      fromEmail: row.fromEmail,
      subject: row.subject,
      bodyPreview: row.bodyPreview,
    });
    if (bounce.isBounce) {
      stats.skippedBounce += 1;
      continue;
    }

    const mailboxEmail = emailByMailboxId.get(row.mailboxId) ?? "";
    const resolved = resolveLegacyOutboundMatch(
      row,
      outboundByMailbox.get(row.mailboxId) ?? [],
      mailboxEmail,
      { relaxedSubject, maxAgeMs },
    );

    if (resolved.kind === "none") {
      stats.noCandidate += 1;
      continue;
    }
    if (resolved.kind === "ambiguous") {
      stats.ambiguous += 1;
      continue;
    }

    const hit = resolved.hit;
    if (dry) {
      console.log(
        `[heuristic] DRY_RUN 将关联 inbox id=${row.id} → outbound id=${hit.id} ` +
          `(subject≈"${normalizeThreadSubject(row.subject)}", from=${normalizeEmail(row.fromEmail)})`,
      );
      stats.matched += 1;
      continue;
    }

    await db
      .update(inboxMessages)
      .set({
        matchStatus: "matched",
        matchedOutboundId: hit.id,
        ...crmPatchFromOutbound(hit),
      })
      .where(eq(inboxMessages.id, row.id));
    stats.matched += 1;
  }

  console.log(
    `[heuristic] 完成：扫描 ${stats.scanned}，关联 ${stats.matched}，歧义跳过 ${stats.ambiguous}，` +
      `无候选 ${stats.noCandidate}，退信跳过 ${stats.skippedBounce}。`,
  );
  return stats;
}

async function findInboxIdsToRequeueMatch(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ id: inboxMessages.id })
    .from(inboxMessages)
    .innerJoin(outboundMessages, eq(inboxMessages.conversationId, outboundMessages.conversationId))
    .where(
      and(
        or(eq(inboxMessages.matchStatus, "ignored"), eq(inboxMessages.matchStatus, "unmatched")),
        notLike(outboundMessages.conversationId, "notion-legacy%"),
      ),
    );
  return rows.map((r) => r.id);
}

async function runRequeueMatch(dry: boolean): Promise<void> {
  const enabled = envTruthy("REQUEUE_MATCH_FOR_CONVERSATION");
  if (!enabled) {
    console.log(
      "[requeue] 未设置 REQUEUE_MATCH_FOR_CONVERSATION=1，跳过重新入队（需 Notion 副作用时再开）。",
    );
    return;
  }

  const ids = await findInboxIdsToRequeueMatch();
  console.log(
    `[requeue] 将处理 ${ids.length} 条 inbox（ignored|unmatched 且存在非 legacy 的 outbound 同 conversation_id）。`,
  );
  if (dry) {
    console.log("[requeue] DRY_RUN：不入队。");
    return;
  }

  let queued = 0;
  for (const inboxRowId of ids) {
    const jobId = `match__reconcile__${inboxRowId}__${Date.now()}`;
    await matchQueue.add("match", { inboxRowId }, { jobId });
    queued += 1;
  }
  console.log(`[requeue] 已入队 match 任务: ${queued}（请确认 worker 与 Redis 可用）。`);
}

async function findInboxIdsToRequeueLegacyHeuristic(): Promise<number[]> {
  const rows = await db
    .select({ id: inboxMessages.id })
    .from(inboxMessages)
    .where(or(eq(inboxMessages.matchStatus, "ignored"), eq(inboxMessages.matchStatus, "unmatched")));
  return rows.map((r) => r.id);
}

async function runRequeueLegacyMatch(dry: boolean): Promise<void> {
  if (!envTruthy("REQUEUE_MATCH_LEGACY_INBOX")) {
    console.log(
      "[requeue-legacy] 未设置 REQUEUE_MATCH_LEGACY_INBOX=1，跳过 ignored|unmatched 重新入队。",
    );
    return;
  }

  const ids = await findInboxIdsToRequeueLegacyHeuristic();
  console.log(`[requeue-legacy] 将把 ${ids.length} 条 ignored|unmatched inbox 交给 match worker（含 legacy 启发式）。`);
  if (dry) {
    console.log("[requeue-legacy] DRY_RUN：不入队。");
    return;
  }

  let queued = 0;
  for (const inboxRowId of ids) {
    const jobId = `match__legacy_reconcile__${inboxRowId}__${Date.now()}`;
    await matchQueue.add("match", { inboxRowId }, { jobId });
    queued += 1;
  }
  console.log(`[requeue-legacy] 已入队 match 任务: ${queued}`);
}

async function main(): Promise<void> {
  const dry = envTruthy("DRY_RUN");
  if (dry) console.log("[DRY_RUN] 不写库、不入队（heuristic 仅打印将关联的行）。");

  await runCrmSync(dry);
  await runHeuristicMatch(dry);
  if (!dry) {
    await runCrmSync(false);
  }
  await runRequeueMatch(dry);
  await runRequeueLegacyMatch(dry);
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
