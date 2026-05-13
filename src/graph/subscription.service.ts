/**
 * Microsoft Graph change notification subscriptions (mail folder messages).
 *
 * Docs: https://learn.microsoft.com/graph/api/subscription-post-subscriptions
 *
 * Requires Application permission **Subscription.ReadWrite.All** in addition
 * to mail read scopes, or delegated equivalent.
 */

import { loadConfig, type AppConfig } from "../config/index.js";
import { graphFetch } from "./client.js";
import { logger } from "../utils/logger.js";

/** Max subscription lifetime for mail resources (~3 days). Stay under the cap. */
const SUBSCRIPTION_TTL_MS = 47 * 60 * 60 * 1000;

export function graphWebhookNotificationUrl(cfg: AppConfig): string {
  const base = cfg.v2.public_base_url.replace(/\/$/, "");
  const p = cfg.v2.webhook_path.startsWith("/") ? cfg.v2.webhook_path : `/${cfg.v2.webhook_path}`;
  return `${base}${p}`;
}

/**
 * OData `resource` string (no leading slash) scoped to one well-known folder.
 * Example: `users/alice@contoso.com/mailFolders/inbox/messages`
 *
 * IMPORTANT: Graph subscription validation rejects percent-encoded "@" in the
 * `resource` field. Always pass the raw UPN here. Folder is a well-known name
 * (e.g. inbox/junkemail) and doesn't need encoding either.
 */
export function mailFolderMessagesResource(mailboxEmail: string, folder: string): string {
  return `users/${mailboxEmail}/mailFolders/${folder}/messages`;
}

export function defaultSubscriptionExpirationIso(): string {
  return new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString();
}

export async function createMailSubscription(params: {
  /** Mailbox the resource belongs to — picks the App used to authorize. */
  actorMailbox: string;
  resource: string;
  notificationUrl: string;
  clientState: string;
  expirationDateTime: string;
}): Promise<{ id: string; expirationDateTime: string }> {
  return graphFetch({
    method: "POST",
    actorMailbox: params.actorMailbox,
    path: "/subscriptions",
    body: {
      changeType: "created,updated",
      notificationUrl: params.notificationUrl,
      resource: params.resource,
      expirationDateTime: params.expirationDateTime,
      clientState: params.clientState,
      latestSupportedTlsVersion: "v1_2",
    },
  }) as Promise<{ id: string; expirationDateTime: string }>;
}

export async function renewMailSubscription(
  actorMailbox: string,
  subscriptionId: string,
  expirationDateTime: string,
): Promise<{ id: string; expirationDateTime: string }> {
  return graphFetch({
    method: "PATCH",
    actorMailbox,
    path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    body: { expirationDateTime },
  }) as Promise<{ id: string; expirationDateTime: string }>;
}

export async function deleteMailSubscription(
  actorMailbox: string,
  subscriptionId: string,
): Promise<void> {
  await graphFetch({
    method: "DELETE",
    actorMailbox,
    path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    expectEmpty: true,
  }).catch((e) => {
    logger.warn({ err: e, subscriptionId, actorMailbox }, "delete subscription failed (may already be gone)");
  });
}

/** Convenience: create subscription for one mailbox folder using global config. */
export async function ensureMailSubscriptionForFolder(
  mailboxEmail: string,
  folder: string,
): Promise<{ id: string; expirationDateTime: string }> {
  const cfg = loadConfig();
  const resource = mailFolderMessagesResource(mailboxEmail, folder);
  const notificationUrl = graphWebhookNotificationUrl(cfg);
  const exp = defaultSubscriptionExpirationIso();
  logger.info({ resource, notificationUrl: notificationUrl.slice(0, 80) }, "creating Graph subscription");
  return createMailSubscription({
    actorMailbox: mailboxEmail,
    resource,
    notificationUrl,
    clientState: cfg.v2.subscription_client_state_secret,
    expirationDateTime: exp,
  });
}
