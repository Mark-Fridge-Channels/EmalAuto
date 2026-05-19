/**
 * One-shot: copy `inbox_messages.match_status` → `outbound_messages.thread_status`
 * for rows reconcile linked without updating thread_status.
 *
 * ```bash
 * DRY_RUN=1 npx tsx scripts/sync-thread-status-from-inbox.ts
 * npx tsx scripts/sync-thread-status-from-inbox.ts
 * ```
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";

function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

async function main(): Promise<void> {
  const dry = envTruthy("DRY_RUN");

  const pendingRes = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM inbox_messages AS i
    INNER JOIN outbound_messages AS o ON o.id = i.matched_outbound_id
    WHERE i.match_status IN ('matched', 'bounce')
      AND o.thread_status = 'sent'
  `);
  const pending = Number((pendingRes.rows[0] as { c?: number })?.c ?? 0);

  console.log(`[sync:thread-status] 待同步 outbound 行: ${pending}（DRY_RUN=${dry ? "是" : "否"}）`);

  if (dry || !pending) return;

  const res = await db.execute(sql`
    UPDATE outbound_messages AS o
    SET
      thread_status = CASE WHEN i.match_status = 'bounce' THEN 'bounce' ELSE 'reply_received' END,
      bounce_reason = CASE
        WHEN i.match_status = 'bounce' THEN COALESCE(o.bounce_reason, 'synced from inbox match_status')
        ELSE o.bounce_reason
      END,
      updated_at = NOW()
    FROM inbox_messages AS i
    WHERE i.matched_outbound_id = o.id
      AND i.match_status IN ('matched', 'bounce')
      AND o.thread_status = 'sent'
  `);

  const n = (res as { rowCount?: number }).rowCount ?? 0;
  console.log(`[sync:thread-status] 已更新 ${n} 行。`);
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
