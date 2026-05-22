/**
 * MSAL Confidential Client — **per-domain** App-only / client_credentials.
 *
 * Each domain in `config.graph_apps` gets its own ConfidentialClientApplication
 * and its own in-process token cache (because each domain is a separate Azure
 * tenant + App).
 *
 * Lookup is by `appKey` (the lower-case domain). Callers that have a mailbox
 * use `acquireGraphTokenForMailbox(email)`; internal/system callers can use
 * `acquireGraphTokenForApp(appKey)` directly.
 *
 * No per-mailbox refresh tokens. No offline_access. No User.Read.
 */

import {
  ConfidentialClientApplication,
  type Configuration,
  type AuthenticationResult,
} from "@azure/msal-node";
import { loadConfig, resolveAppKeyForMailbox } from "../config/index.js";
import { getEffectiveGraphAppsSync } from "../config/graph-apps.runtime.js";
import { logger } from "../utils/logger.js";

export class MissingGraphAppError extends Error {
  constructor(public readonly mailboxEmail: string) {
    super(`no graph_apps entry matches mailbox "${mailboxEmail}"`);
    this.name = "MissingGraphAppError";
  }
}

interface CachedToken {
  accessToken: string;
  expiresOn: Date;
}

const clients = new Map<string, ConfidentialClientApplication>();
const cache = new Map<string, CachedToken>();

function buildClientForApp(appKey: string): ConfidentialClientApplication {
  const cfg = loadConfig();
  const app = getEffectiveGraphAppsSync(cfg)[appKey];
  if (!app) {
    throw new Error(`graph_apps["${appKey}"] not configured`);
  }
  const authority = `${cfg.graph_defaults.authority.replace(/\/$/, "")}/${app.tenant_id}`;

  const auth: Configuration["auth"] = {
    clientId: app.client_id,
    authority,
    clientSecret: app.client_secret,
  };

  return new ConfidentialClientApplication({
    auth,
    system: {
      loggerOptions: {
        loggerCallback: (_lvl, message) => logger.debug({ msal: true, app: appKey }, message),
        piiLoggingEnabled: false,
      },
    },
  });
}

function getClient(appKey: string): ConfidentialClientApplication {
  let c = clients.get(appKey);
  if (!c) {
    c = buildClientForApp(appKey);
    clients.set(appKey, c);
  }
  return c;
}

export interface AcquireOptions {
  /** Force refresh, bypassing the in-process cache. */
  force?: boolean;
}

/**
 * Acquire an App-only access token for Microsoft Graph for a specific
 * configured App (key = domain). Uses .default scope so admin-consented
 * Application permissions apply.
 */
export async function acquireGraphTokenForApp(
  appKey: string,
  opts: AcquireOptions = {},
): Promise<string> {
  const cfg = loadConfig();
  const skew = cfg.polling.token_warm_skew_ms;

  const cached = cache.get(appKey);
  if (!opts.force && cached && cached.expiresOn.getTime() - Date.now() > skew) {
    return cached.accessToken;
  }

  const result: AuthenticationResult | null = await getClient(appKey).acquireTokenByClientCredential({
    scopes: cfg.graph_defaults.scopes,
    skipCache: opts.force === true,
  });
  if (!result?.accessToken || !result.expiresOn) {
    throw new Error(`MSAL returned an empty token result for app "${appKey}"`);
  }
  cache.set(appKey, { accessToken: result.accessToken, expiresOn: result.expiresOn });
  logger.info(
    {
      app: appKey,
      expiresOn: result.expiresOn.toISOString(),
      tenantId: getEffectiveGraphAppsSync(cfg)[appKey]?.tenant_id,
    },
    "graph app token acquired",
  );
  return result.accessToken;
}

/** Drop cached MSAL clients + tokens for the given app keys (after DB graph_apps hot reload). */
export function evictGraphAppClients(appKeys: string[]): void {
  for (const k of appKeys) {
    clients.delete(k);
    cache.delete(k);
  }
}

/**
 * Resolve the App key for a mailbox (by domain) and get a token. Throws
 * `MissingGraphAppError` when no `graph_apps` entry matches.
 */
export async function acquireGraphTokenForMailbox(
  mailboxEmail: string,
  opts: AcquireOptions = {},
): Promise<string> {
  const appKey = resolveAppKeyForMailbox(mailboxEmail);
  if (!appKey) throw new MissingGraphAppError(mailboxEmail);
  return acquireGraphTokenForApp(appKey, opts);
}

/** Drop the in-process cache (all apps). Useful for tests / forced rotation. */
export function clearTokenCache(): void {
  cache.clear();
  clients.clear();
}

/** True when an in-process token exists and is still valid beyond the warm skew. */
export function hasValidCachedToken(appKey: string): boolean {
  const cfg = loadConfig();
  const skew = cfg.polling.token_warm_skew_ms;
  const cached = cache.get(appKey);
  return Boolean(cached && cached.expiresOn.getTime() - Date.now() > skew);
}

/** Inspect the cache snapshot (for /health). */
export function peekCachedTokens(): Array<{ app: string; expiresOn: string }> {
  return Array.from(cache.entries()).map(([app, t]) => ({
    app,
    expiresOn: t.expiresOn.toISOString(),
  }));
}
