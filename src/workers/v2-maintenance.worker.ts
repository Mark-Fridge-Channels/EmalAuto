/**
 * V2 maintenance: Graph subscriptions + delta catch-up.
 *
 * - Bootstraps / renews mail folder subscriptions before they expire.
 * - Runs periodic delta sync per mailbox+folder (webhook compensation).
 *
 * Always started from `worker.ts` when `config.v2.enabled` is true.
 */

import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { listEnabledMailboxes, setFolderCursor } from "../db/repositories/mailbox.repo.js";
import {
  findWebhookRow,
  upsertWebhookRow,
  updateDeltaLink,
} from "../db/repositories/webhook.repo.js";
import {
  defaultSubscriptionExpirationIso,
  deleteMailSubscription,
  ensureMailSubscriptionForFolder,
  renewMailSubscription,
} from "../graph/subscription.service.js";
import { runDeltaSyncForFolder } from "../graph/delta.service.js";

let subInterval: NodeJS.Timeout | null = null;
let deltaInterval: NodeJS.Timeout | null = null;
let started = false;

function renewLeadMs(): number {
  return loadConfig().v2.subscription_renew_lead_hours * 60 * 60 * 1000;
}

type EnsureAction = "created" | "renewed" | "skipped";

async function ensureSubscriptionForMailboxFolder(
  box: { id: number; email: string },
  folder: string,
): Promise<EnsureAction> {
  const row = await findWebhookRow(box.id, folder);
  const lead = renewLeadMs();
  const now = Date.now();
  if (row && new Date(row.expiresAt).getTime() - now > lead) {
    logger.debug(
      {
        mailbox: box.email,
        folder,
        subId: row.subscriptionId,
        expiresAt: row.expiresAt,
      },
      "subscription still valid, skipping",
    );
    return "skipped";
  }

  if (row?.subscriptionId) {
    try {
      const newExp = defaultSubscriptionExpirationIso();
      const r = await renewMailSubscription(box.email, row.subscriptionId, newExp);
      await upsertWebhookRow({
        mailboxId: box.id,
        folder,
        subscriptionId: r.id ?? row.subscriptionId,
        expiresAt: new Date(r.expirationDateTime),
        deltaLink: row.deltaLink,
      });
      logger.info({ mailbox: box.email, folder, subId: r.id }, "subscription renewed");
      return "renewed";
    } catch (err) {
      logger.warn({ err, mailbox: box.email, folder }, "subscription renew failed; recreating");
      await deleteMailSubscription(box.email, row.subscriptionId);
    }
  }

  const created = await ensureMailSubscriptionForFolder(box.email, folder);
  await upsertWebhookRow({
    mailboxId: box.id,
    folder,
    subscriptionId: created.id,
    expiresAt: new Date(created.expirationDateTime),
    deltaLink: row?.deltaLink ?? null,
  });
  logger.info({ mailbox: box.email, folder, subId: created.id }, "subscription created");
  return "created";
}

async function tickSubscriptionsOnce(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.v2.enabled) return;
  const boxes = await listEnabledMailboxes();
  const receiveBoxes = boxes.filter((b) => b.canReceive);
  logger.info(
    {
      mailboxes: receiveBoxes.length,
      folders: cfg.folders,
      pairs: receiveBoxes.length * cfg.folders.length,
    },
    "tick subscriptions: scanning",
  );
  let created = 0;
  let renewed = 0;
  let skipped = 0;
  let failed = 0;
  for (const box of receiveBoxes) {
    for (const folder of cfg.folders) {
      try {
        const action = await ensureSubscriptionForMailboxFolder(box, folder);
        if (action === "created") created += 1;
        else if (action === "renewed") renewed += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        const hint =
          msg.includes("[ValidationError]") || msg.includes("ValidationError")
            ? " — likely the notificationUrl didn't pass Graph's validation handshake. Common causes: ngrok-free interstitial page, non-200/non-text-plain response, ≥10s latency, wrong V2_WEBHOOK_PATH, or API process not running. Test with: curl -i '<V2_PUBLIC_BASE_URL><V2_WEBHOOK_PATH>?validationToken=hello'"
            : "";
        logger.error(
          { err, mailbox: box.email, folder, hint: hint || undefined },
          "ensure subscription failed",
        );
      }
    }
  }
  logger.info(
    { created, renewed, skipped, failed },
    "tick subscriptions: done",
  );
}

async function tickDeltaOnce(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.v2.enabled) return;
  const boxes = await listEnabledMailboxes();
  for (const box of boxes) {
    if (!box.canReceive) continue;
    for (const folder of cfg.folders) {
      try {
        const row = await findWebhookRow(box.id, folder);
        const { deltaLink, maxReceivedAt } = await runDeltaSyncForFolder({
          mailboxId: box.id,
          mailboxEmail: box.email,
          folder,
          deltaLink: row?.deltaLink ?? null,
        });
        if (deltaLink) await updateDeltaLink(box.id, folder, deltaLink);
        if (maxReceivedAt) await setFolderCursor(box.id, folder, maxReceivedAt);
      } catch (err) {
        logger.error({ err, mailbox: box.email, folder }, "delta sync failed");
      }
    }
  }
}

export async function bootstrapV2Once(): Promise<void> {
  await tickSubscriptionsOnce();
  await tickDeltaOnce();
}

export function startV2Maintenance(): void {
  if (started) return;
  const cfg = loadConfig();
  if (!cfg.v2.enabled) return;
  started = true;

  void bootstrapV2Once().catch((e) => logger.error({ err: e }, "V2 bootstrap failed"));

  subInterval = setInterval(() => void tickSubscriptionsOnce().catch((e) => logger.error({ err: e }, "sub tick")), 60 * 60 * 1000);
  deltaInterval = setInterval(
    () => void tickDeltaOnce().catch((e) => logger.error({ err: e }, "delta tick")),
    cfg.v2.delta_sync_interval_ms,
  );
  logger.info(
    { deltaMs: cfg.v2.delta_sync_interval_ms, renewLeadH: cfg.v2.subscription_renew_lead_hours },
    "V2 maintenance timers started",
  );
}

export function stopV2Maintenance(): void {
  if (subInterval) {
    clearInterval(subInterval);
    subInterval = null;
  }
  if (deltaInterval) {
    clearInterval(deltaInterval);
    deltaInterval = null;
  }
  started = false;
  logger.info("V2 maintenance stopped");
}
