/**
 * Aggregated runtime status for the admin console (read-only).
 */

import { acquireGraphTokenForApp, peekCachedTokens } from "../auth/msal.js";
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
import type { Queue } from "bullmq";

export type QueueStatusRow = {
  name: string;
  label: string;
  expected: boolean;
  workers: number;
  jobs: { waiting: number; active: number; delayed: number; failed: number };
};

export type SystemStatusPayload = {
  checkedAt: string;
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
): Promise<QueueStatusRow> {
  const [workers, counts] = await Promise.all([
    queue.getWorkersCount(),
    queue.getJobCounts("waiting", "active", "delayed", "failed"),
  ]);
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
}

export async function buildSystemStatus(): Promise<SystemStatusPayload> {
  const cfg = loadConfig();
  const appKeys = Object.keys(getEffectiveGraphAppsSync(cfg));
  const v2 = cfg.v2.enabled;
  const inboxScheduler = !v2 || !cfg.v2.disable_polling_when_v2;
  const webhookExpected = v2;

  const [dbOk, redisOk, notionOk, graphAppResults, queueRows] = await Promise.all([
    pingDb(),
    pingRedis(),
    retrieveDatabase(cfg.notion.database_id)
      .then(() => true)
      .catch(() => false),
    Promise.all(
      appKeys.map(async (k) => {
        try {
          await acquireGraphTokenForApp(k);
          return [k, true] as const;
        } catch {
          return [k, false] as const;
        }
      }),
    ),
    Promise.all([
      queueRow(sendQueue, "send", "发信 (send)", true),
      queueRow(matchQueue, "match", "匹配 (match)", true),
      queueRow(inboxPollQueue, "inbox-poll", "收件轮询 (inbox-poll)", true),
      queueRow(webhookIngestQueue, "webhook-ingest", "Webhook 入库", webhookExpected),
    ]),
  ]);

  const graphApps = Object.fromEntries(graphAppResults);
  const graphOk = appKeys.length > 0 && Object.values(graphApps).every(Boolean);
  const depsOk = dbOk && redisOk && notionOk && graphOk;

  const expectedQueues = queueRows.filter((q) => q.expected);
  const workerRunning = expectedQueues.every((q) => q.workers > 0);
  const missing = expectedQueues.filter((q) => q.workers === 0).map((q) => q.name);

  let workerDetail: string;
  if (workerRunning) {
    workerDetail = "BullMQ 各预期队列均有已注册 worker（`npm run dev:worker` 或 Docker `worker` 服务）。";
  } else if (!redisOk) {
    workerDetail = "Redis 不可用，无法探测 worker。";
  } else if (missing.length > 0) {
    workerDetail = `以下队列无 worker：${missing.join(", ")}。请启动 worker 进程。`;
  } else {
    workerDetail = "Worker 未就绪。";
  }

  return {
    checkedAt: new Date().toISOString(),
    api: {
      running: true,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeEnv: process.env.NODE_ENV ?? "development",
      notionPoller: isNotionPollerRunning(),
    },
    worker: {
      running: redisOk && workerRunning,
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
