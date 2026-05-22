/**
 * Aggregated runtime status for the admin console (read-only).
 *
 * Probes use short deadlines so APISIX/nginx upstream timeouts (often 60s)
 * are not hit when Notion / Azure / Redis / BullMQ is slow or unreachable.
 */

import { acquireGraphTokenForApp, hasValidCachedToken, peekCachedTokens } from "../auth/msal.js";
import { loadConfig } from "../config/index.js";
import { getEffectiveGraphAppsSync } from "../config/graph-apps.runtime.js";
import { pingDb } from "../db/client.js";
import { isNotionPollerRunning } from "../notion/poller.js";
import { retrieveDatabase } from "../notion/client.js";
import {
  inboxPollQueue,
  matchQueue,
  sendQueue,
  webhookIngestQueue,
} from "../queues/queues.js";
import { pingRedis } from "../queues/connection.js";
import { withTimeout, withTimeoutOr } from "../utils/with-timeout.js";
import type { Queue } from "bullmq";

const MS = {
  db: 5_000,
  redis: 5_000,
  notion: 12_000,
  graphAcquire: 10_000,
  queue: 8_000,
} as const;

export type QueueStatusRow = {
  name: string;
  label: string;
  expected: boolean;
  workers: number;
  jobs: { waiting: number; active: number; delayed: number; failed: number };
  /** Set when BullMQ/Redis probe did not finish in time (do not treat workers=0 as down). */
  probeTimedOut?: boolean;
};

export type SystemStatusPayload = {
  checkedAt: string;
  warnings: string[];
  api: {
    running: true;
    uptimeSeconds: number;
    nodeEnv: string;
    notionPoller: boolean;
  };
  worker: {
    running: boolean;
    detail: string;
  };
  dependencies: {
    ok: boolean;
    postgres: boolean;
    redis: boolean;
    notion: boolean;
    graph: boolean;
  };
  graphApps: Record<string, boolean>;
  queues: QueueStatusRow[];
  config: {
    v2Enabled: boolean;
    inboxPollingScheduler: boolean;
    webhookIngestWorker: boolean;
  };
  tokensCached: number;
};

async function queueRow(
  queue: Queue,
  name: string,
  label: string,
  expected: boolean,
  warnings: string[],
): Promise<QueueStatusRow> {
  const emptyJobs = { waiting: 0, active: 0, delayed: 0, failed: 0 };
  try {
    const [workers, counts] = await withTimeout(
      Promise.all([
        queue.getWorkersCount(),
        queue.getJobCounts("waiting", "active", "delayed", "failed"),
      ]),
      MS.queue,
    );
    return {
      name,
      label,
      expected,
      workers,
      jobs: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      },
    };
  } catch {
    warnings.push(`队列 ${name} 探测超时（${MS.queue / 1000}s）`);
    return {
      name,
      label,
      expected,
      workers: 0,
      jobs: emptyJobs,
      probeTimedOut: true,
    };
  }
}

async function checkGraphApp(appKey: string, warnings: string[]): Promise<readonly [string, boolean]> {
  if (hasValidCachedToken(appKey)) return [appKey, true] as const;
  try {
    await withTimeout(acquireGraphTokenForApp(appKey), MS.graphAcquire);
    return [appKey, true] as const;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout")) {
      warnings.push(`Graph App ${appKey} token 探测超时（${MS.graphAcquire / 1000}s）`);
    }
    return [appKey, false] as const;
  }
}

export async function buildSystemStatus(): Promise<SystemStatusPayload> {
  const cfg = loadConfig();
  const warnings: string[] = [];
  const appKeys = Object.keys(getEffectiveGraphAppsSync(cfg));
  const v2 = cfg.v2.enabled;
  const inboxScheduler = !v2 || !cfg.v2.disable_polling_when_v2;
  const webhookExpected = v2;

  const [dbOk, redisOk, notionOk, graphAppResults, queueRows] = await Promise.all([
    withTimeoutOr(pingDb(), MS.db, false),
    withTimeoutOr(pingRedis(), MS.redis, false),
    withTimeoutOr(
      retrieveDatabase(cfg.notion.database_id)
        .then(() => true)
        .catch(() => false),
      MS.notion,
      false,
    ).then((ok) => {
      if (!ok) warnings.push(`Notion 探测超时或失败（${MS.notion / 1000}s）`);
      return ok;
    }),
    Promise.all(appKeys.map((k) => checkGraphApp(k, warnings))),
    Promise.all([
      queueRow(sendQueue, "send", "发信 (send)", true, warnings),
      queueRow(matchQueue, "match", "匹配 (match)", true, warnings),
      queueRow(inboxPollQueue, "inbox-poll", "收件轮询 (inbox-poll)", true, warnings),
      queueRow(webhookIngestQueue, "webhook-ingest", "Webhook 入库", webhookExpected, warnings),
    ]),
  ]);

  const graphApps = Object.fromEntries(graphAppResults);
  const graphOk = appKeys.length > 0 && Object.values(graphApps).every(Boolean);
  const depsOk = dbOk && redisOk && notionOk && graphOk;

  const expectedQueues = queueRows.filter((q) => q.expected);
  const queueProbeOk = expectedQueues.every((q) => !q.probeTimedOut);
  const workerRunning =
    redisOk && queueProbeOk && expectedQueues.every((q) => q.workers > 0);
  const missing = expectedQueues.filter((q) => !q.probeTimedOut && q.workers === 0).map((q) => q.name);

  let workerDetail: string;
  if (!redisOk) {
    workerDetail = "Redis 不可用，无法探测 worker。";
  } else if (!queueProbeOk) {
    workerDetail = "队列探测超时，worker 状态可能不准确；请查看上方警告或检查 Redis。";
  } else if (workerRunning) {
    workerDetail = "BullMQ 各预期队列均有已注册 worker（`npm run dev:worker` 或 Docker `worker` 服务）。";
  } else if (missing.length > 0) {
    workerDetail = `以下队列无 worker：${missing.join(", ")}。请启动 worker 进程。`;
  } else {
    workerDetail = "Worker 未就绪。";
  }

  return {
    checkedAt: new Date().toISOString(),
    warnings,
    api: {
      running: true,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeEnv: process.env.NODE_ENV ?? "development",
      notionPoller: isNotionPollerRunning(),
    },
    worker: {
      running: workerRunning,
      detail: workerDetail,
    },
    dependencies: {
      ok: depsOk,
      postgres: dbOk,
      redis: redisOk,
      notion: notionOk,
      graph: graphOk,
    },
    graphApps,
    queues: queueRows,
    config: {
      v2Enabled: v2,
      inboxPollingScheduler: inboxScheduler,
      webhookIngestWorker: webhookExpected,
    },
    tokensCached: peekCachedTokens().length,
  };
}
