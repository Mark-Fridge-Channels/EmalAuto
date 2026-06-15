/**
 * Configuration loader — **environment variables only**.
 *
 * Reads from `process.env`. We auto-load `.env` from CWD (if present) before
 * the first `loadConfig()` call so `node`/`tsx` invocations get the same
 * surface as `npm run dev`.
 *
 * Layout conventions:
 *
 *   - Scalar fields:   NOTION_TOKEN, GRAPH_AUTHORITY, SERVER_PORT, ...
 *   - CSV arrays:      FOLDERS=inbox,junkemail
 *   - Per-domain App:  GRAPH_APP_<N>_DOMAIN / _TENANT_ID / _CLIENT_ID / _CLIENT_SECRET
 *
 * Indexed `GRAPH_APP_*` groups are scanned starting at 1 and stop at the first
 * missing `_DOMAIN`. Use `.env.example` as the source of truth for keys.
 */

import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import { getEffectiveGraphAppsSync } from "./graph-apps.runtime.js";

// ---------- env file loading ----------

let envLoaded = false;
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  const explicit = process.env.DOTENV_PATH?.trim();
  const candidate = explicit
    ? path.isAbsolute(explicit)
      ? explicit
      : path.resolve(process.cwd(), explicit)
    : path.resolve(process.cwd(), ".env");
  if (fs.existsSync(candidate)) {
    dotenvConfig({ path: candidate });
  }
}

// ---------- primitive parsers ----------

function envStr(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback ?? "";
  return v;
}

function envRequired(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`env: ${name} is required`);
  }
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env: ${name} must be an integer, got "${v}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new Error(`env: ${name} must be boolean-ish, got "${v}"`);
}

function envCsv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- zod schema (shape consumed by callers) ----------

const propertyNamesSchema = z.object({
  Status: z.string().min(1),
  Action: z.string().min(1),
  Platform: z.string().min(1),
  InNOut: z.string().min(1),
  sender_email: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  payload: z.string().min(1),
  completion_time: z.string().min(1),
  result_remark: z.string().min(1),
  reply_status: z.string().min(1),
  reply_body: z.string().min(1),
  reply_email: z.string().min(1),
  last_reply_time: z.string().min(1),
  /** When to start sending; poller only enqueues when empty (= ASAP) or datetime ≤ now. */
  trigger_time: z.string().min(1),
  task_id: z.string().min(1),
  /** Comma-separated Cc addresses (rich_text on Interaction LOG). */
  cc: z.string().min(1),
});

const notionDtcSchema = z.object({
  il_columns: z.object({
    dtc_entity: z.string().min(1),
    dtc_key_person: z.string().min(1),
    current_status: z.string().min(1),
    target_status: z.string().min(1),
  }),
  entity_columns: z.object({
    cold_reach_status: z.string().min(1),
  }),
  key_person_columns: z.object({
    email: z.string().min(1),
    email_verified_status: z.string().min(1),
  }),
  key_person_email_verified_value: z.string().min(1),
  /** DTC Key Person Email Verified Status written when a bounce is matched. */
  key_person_email_failed_value: z.string().min(1),
  /** DTC Entity ColdReach Status written when a **human** inbound reply is matched. */
  human_reply_cold_reach_status: z.string().min(1),
  /** Columns on linked DTC Key Person / Entity pages → PG CRM fields. */
  sync_columns: z.object({
    kp_id_prop: z.string(),
    kp_name_prop: z.string(),
    entity_name_prop: z.string(),
  }),
});

const notionSchema = z.object({
  token: z.string().min(1),
  database_id: z.string().min(1),
  notion_version: z.string().min(1),
  property_names: propertyNamesSchema,
  dtc: notionDtcSchema,
  /** Optional Notion column names to copy KeyPerson / Entity into PG (empty = skip). */
  crm_columns: z.object({
    key_person_id: z.string(),
    key_person_name: z.string(),
    key_person_url: z.string(),
    entity_name: z.string(),
    entity_url: z.string(),
  }),
  status_values: z.object({
    todo: z.string().min(1),
    in_flight: z.string().min(1),
    success: z.string().min(1),
    failure: z.string().min(1),
  }),
  action_values: z.object({
    send: z.string().min(1),
    reply: z.string().min(1),
    /** Written on the NEW Notion row we create when an inbound reply is matched. */
    inbound_reply: z.string().min(1),
  }),
  reply_status_values: z.object({
    /** Stamped on the ORIGINAL outbound row's "Reply Status" once its inbound reply has a child row. */
    done: z.string().min(1),
  }),
  platform_value: z.string().min(1),
  in_n_out_value: z.string().min(1),
  /** Value written into InNOut for the new inbound-reply child row (default "In"). */
  in_n_out_inbound_value: z.string().min(1),
});

const graphAppSchema = z.object({
  tenant_id: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

const pollingSchema = z.object({
  notion_interval_ms: z.number().int().min(5000).max(120_000),
  inbox_interval_ms: z.number().int().min(10_000).max(600_000),
  token_warm_skew_ms: z.number().int().min(60_000).max(3_600_000),
  send_concurrency: z.number().int().min(1).max(50),
  inbox_concurrency: z.number().int().min(1).max(50),
  match_concurrency: z.number().int().min(1).max(50),
});

const postgresSchema = z.object({
  url: z.string().min(1, "DATABASE_URL required"),
  max_pool: z.number().int().min(1).max(100),
});

const redisSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  password: z.string(),
  db: z.number().int().min(0).max(15),
});

const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

const loggingSchema = z.object({
  level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  pretty: z.boolean(),
});

const v2Schema = z
  .object({
    enabled: z.boolean(),
    public_base_url: z.string(),
    webhook_path: z.string(),
    subscription_client_state_secret: z.string(),
    subscription_renew_lead_hours: z.number().min(1).max(96),
    delta_sync_interval_ms: z.number().int().min(60_000).max(3_600_000),
    disable_polling_when_v2: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.public_base_url.startsWith("https://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["public_base_url"],
        message: "V2_PUBLIC_BASE_URL must start with https:// when V2_ENABLED=true",
      });
    }
    if (v.subscription_client_state_secret.trim().length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subscription_client_state_secret"],
        message: "V2_CLIENT_STATE_SECRET must be at least 8 chars when V2_ENABLED=true",
      });
    }
  });

const adminUISchema = z.object({
  /** When true, `/api/*` admin + static web UI are registered (requires `ui_password`). */
  enabled: z.boolean(),
  ui_password: z.string(),
  /** Used to sign session cookies (min 16 chars). */
  session_secret: z.string().min(16),
  /** Session cookie lifetime in milliseconds (`@fastify/session` uses ms, not seconds). */
  session_max_age_ms: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000),
});

const mailSchema = z.object({
  /** Appended after sender name signature on every outbound body. */
  opt_out_footer_text: z.string().min(1),
  /** Path segment for RFC 8058 one-click POST (joined with V2_PUBLIC_BASE_URL). */
  list_unsubscribe_path: z.string().min(1),
  /** HMAC secret for unsubscribe tokens (min 8 chars when headers are issued). */
  list_unsubscribe_token_secret: z.string(),
  list_unsubscribe_token_ttl_days: z.number().int().min(1).max(730),
});

export const configSchema = z
  .object({
    notion: notionSchema,
    graph_apps_source: z.enum(["env", "db"]),
    graph_apps: z.record(z.string().min(1), graphAppSchema),
    graph_defaults: z.object({
      scopes: z.array(z.string().min(1)),
      authority: z.string().min(1),
    }),
    folders: z.array(z.string().min(1)),
    polling: pollingSchema,
    postgres: postgresSchema,
    redis: redisSchema,
    server: serverSchema,
    logging: loggingSchema,
    v2: v2Schema,
    admin: adminUISchema,
    mail: mailSchema,
  })
  .superRefine((c, ctx) => {
    const keys = Object.keys(c.graph_apps);
    if (c.graph_apps_source === "env" && keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["graph_apps"],
        message: "graph_apps must contain at least one entry when GRAPH_APPS_SOURCE=env (set GRAPH_APP_1_DOMAIN, ...)",
      });
    }
    for (const k of keys) {
      if (k !== k.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["graph_apps", k],
          message: `graph_apps key must be lower-case domain, got "${k}"`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

// ---------- indexed group scanners ----------

function readGraphAppsFromEnv(): Record<string, { tenant_id: string; client_id: string; client_secret: string }> {
  const out: Record<string, { tenant_id: string; client_id: string; client_secret: string }> = {};
  for (let i = 1; i < 100; i++) {
    const domain = process.env[`GRAPH_APP_${i}_DOMAIN`];
    if (!domain) break;
    out[domain.trim().toLowerCase()] = {
      tenant_id: envRequired(`GRAPH_APP_${i}_TENANT_ID`),
      client_id: envRequired(`GRAPH_APP_${i}_CLIENT_ID`),
      client_secret: envRequired(`GRAPH_APP_${i}_CLIENT_SECRET`),
    };
  }
  return out;
}

// ---------- main loader ----------

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureEnvLoaded();

  const graphAppsSourceRaw = envStr("GRAPH_APPS_SOURCE", "env").toLowerCase();
  const graph_apps_source = graphAppsSourceRaw === "db" ? "db" : "env";
  const adminPassword = envStr("ADMIN_UI_PASSWORD", "");
  const sessionSecret = envStr("ADMIN_SESSION_SECRET", "dev-change-me-32chars-minimum!");

  const raw = {
    notion: {
      token: envRequired("NOTION_TOKEN"),
      database_id: envRequired("NOTION_DATABASE_ID"),
      notion_version: envStr("NOTION_VERSION", "2022-06-28"),
      crm_columns: {
        key_person_id: envStr("NOTION_COL_KEYPERSON_ID", ""),
        key_person_name: envStr("NOTION_COL_KEYPERSON_NAME", ""),
        key_person_url: envStr("NOTION_COL_KEYPERSON_URL", ""),
        entity_name: envStr("NOTION_COL_ENTITY_NAME", ""),
        entity_url: envStr("NOTION_COL_ENTITY_URL", ""),
      },
      property_names: {
        Status: envRequired("NOTION_COL_STATUS"),
        Action: envRequired("NOTION_COL_ACTION"),
        Platform: envRequired("NOTION_COL_PLATFORM"),
        InNOut: envRequired("NOTION_COL_INNOUT"),
        sender_email: envRequired("NOTION_COL_SENDER_EMAIL"),
        subject: envRequired("NOTION_COL_SUBJECT"),
        body: envRequired("NOTION_COL_BODY"),
        payload: envRequired("NOTION_COL_PAYLOAD"),
        completion_time: envRequired("NOTION_COL_COMPLETION_TIME"),
        result_remark: envRequired("NOTION_COL_RESULT_REMARK"),
        reply_status: envRequired("NOTION_COL_REPLY_STATUS"),
        reply_body: envRequired("NOTION_COL_REPLY_BODY"),
        reply_email: envRequired("NOTION_COL_REPLY_EMAIL"),
        last_reply_time: envRequired("NOTION_COL_LAST_REPLY_TIME"),
        trigger_time: envRequired("NOTION_COL_TRIGGER_TIME"),
        task_id: envRequired("NOTION_COL_TASK_ID"),
        cc: envStr("NOTION_COL_CC", "cc"),
      },
      status_values: {
        todo: envRequired("NOTION_STATUS_TODO"),
        in_flight: envRequired("NOTION_STATUS_IN_FLIGHT"),
        success: envRequired("NOTION_STATUS_SUCCESS"),
        failure: envRequired("NOTION_STATUS_FAILURE"),
      },
      action_values: {
        send: envRequired("NOTION_ACTION_SEND"),
        reply: envRequired("NOTION_ACTION_REPLY"),
        inbound_reply: envStr("NOTION_ACTION_INBOUND_REPLY", "Inbound Reply"),
      },
      reply_status_values: {
        done: envStr("NOTION_REPLY_STATUS_DONE", "Done"),
      },
      platform_value: envRequired("NOTION_PLATFORM_VALUE"),
      in_n_out_value: envRequired("NOTION_IN_N_OUT_VALUE"),
      in_n_out_inbound_value: envStr("NOTION_IN_N_OUT_INBOUND_VALUE", "In"),
      dtc: {
        il_columns: {
          dtc_entity: envStr("NOTION_IL_DTC_ENTITY", "DTC Entity"),
          dtc_key_person: envStr("NOTION_IL_DTC_KEY_PERSON", "DTC Key Person"),
          current_status: envStr("NOTION_IL_CURRENT_STATUS", "Current Status"),
          target_status: envStr("NOTION_IL_TARGET_STATUS", "Target Status"),
        },
        entity_columns: {
          cold_reach_status: envStr("NOTION_DTC_ENTITY_COL_COLD_REACH", "ColdReach Status"),
        },
        key_person_columns: {
          email: envStr("NOTION_DTC_KP_COL_EMAIL", "Email"),
          email_verified_status: envStr(
            "NOTION_DTC_KP_COL_EMAIL_VERIFIED",
            "Email Verified Status",
          ),
        },
        key_person_email_verified_value: envStr("NOTION_DTC_KP_EMAIL_VERIFIED_VALUE", "Verified"),
        key_person_email_failed_value: envStr(
          "NOTION_DTC_KP_EMAIL_FAILED_VALUE",
          "Send Email Failed",
        ),
        human_reply_cold_reach_status: envStr("NOTION_DTC_HUMAN_REPLY_COLD_REACH", "Humen"),
        sync_columns: {
          kp_id_prop: envStr("NOTION_IL_SYNC_KP_ID_PROP", "ID"),
          kp_name_prop: envStr("NOTION_IL_SYNC_KP_NAME_PROP", "name"),
          entity_name_prop: envStr("NOTION_IL_SYNC_ENTITY_NAME_PROP", "Entity Name"),
        },
      },
    },
    graph_apps_source,
    graph_apps: graph_apps_source === "db" ? {} : readGraphAppsFromEnv(),
    graph_defaults: {
      scopes: envCsv("GRAPH_SCOPES", ["https://graph.microsoft.com/.default"]),
      authority: envStr("GRAPH_AUTHORITY", "https://login.microsoftonline.com"),
    },
    folders: envCsv("FOLDERS", ["inbox", "junkemail"]),
    polling: {
      notion_interval_ms: envInt("POLL_NOTION_INTERVAL_MS", 15_000),
      inbox_interval_ms: envInt("POLL_INBOX_INTERVAL_MS", 30_000),
      token_warm_skew_ms: envInt("TOKEN_WARM_SKEW_MS", 300_000),
      send_concurrency: envInt("SEND_CONCURRENCY", 4),
      inbox_concurrency: envInt("INBOX_CONCURRENCY", 4),
      match_concurrency: envInt("MATCH_CONCURRENCY", 8),
    },
    postgres: {
      url: envRequired("DATABASE_URL"),
      max_pool: envInt("PG_MAX_POOL", 10),
    },
    redis: {
      host: envStr("REDIS_HOST", "127.0.0.1"),
      port: envInt("REDIS_PORT", 6379),
      password: envStr("REDIS_PASSWORD", ""),
      db: envInt("REDIS_DB", 0),
    },
    server: {
      host: envStr("SERVER_HOST", "127.0.0.1"),
      port: envInt("SERVER_PORT", 3737),
    },
    logging: {
      level: (envStr("LOG_LEVEL", "info") as AppConfig["logging"]["level"]) ?? "info",
      pretty: envBool("LOG_PRETTY", true),
    },
    v2: {
      enabled: envBool("V2_ENABLED", false),
      public_base_url: envStr("V2_PUBLIC_BASE_URL", ""),
      webhook_path: envStr("V2_WEBHOOK_PATH", "/webhooks/graph"),
      subscription_client_state_secret: envStr("V2_CLIENT_STATE_SECRET", ""),
      subscription_renew_lead_hours: envInt("V2_RENEW_LEAD_HOURS", 12),
      delta_sync_interval_ms: envInt("V2_DELTA_SYNC_INTERVAL_MS", 300_000),
      disable_polling_when_v2: envBool("V2_DISABLE_POLLING_WHEN_V2", false),
    },
    admin: {
      enabled: adminPassword.length > 0,
      ui_password: adminPassword,
      session_secret: sessionSecret,
      session_max_age_ms: envInt("ADMIN_SESSION_MAX_AGE_DAYS", 30) * 24 * 60 * 60 * 1000,
    },
    mail: {
      opt_out_footer_text: envStr(
        "MAIL_OPT_OUT_FOOTER_TEXT",
        "Not the right time? Reply 'stop' and I won't write again.",
      ),
      list_unsubscribe_path: envStr("LIST_UNSUBSCRIBE_PATH", "/unsubscribe"),
      list_unsubscribe_token_secret:
        envStr("LIST_UNSUBSCRIBE_TOKEN_SECRET", "") ||
        envStr("V2_CLIENT_STATE_SECRET", "") ||
        sessionSecret,
      list_unsubscribe_token_ttl_days: envInt("LIST_UNSUBSCRIBE_TOKEN_TTL_DAYS", 365),
    },
  };

  const parsed = configSchema.parse(raw);
  cached = parsed;
  return parsed;
}

// ---------- helpers exposed to the rest of the app ----------

/**
 * Resolve the App key for a mailbox by its email domain (case-insensitive).
 * Returns `null` if no `graph_apps` entry matches.
 */
export function resolveAppKeyForMailbox(
  mailboxEmail: string,
  cfg: AppConfig = loadConfig(),
): string | null {
  const at = mailboxEmail.lastIndexOf("@");
  if (at < 0) return null;
  const domain = mailboxEmail.slice(at + 1).toLowerCase();
  const apps = getEffectiveGraphAppsSync(cfg);
  return apps[domain] ? domain : null;
}

function mask(secret: string, head = 4, tail = 2): string {
  if (!secret) return "(empty)";
  if (secret.length <= head + tail) return "*".repeat(secret.length);
  return `${secret.slice(0, head)}…${secret.slice(-tail)}`;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return mask(url, 8, 6);
  }
}

/** Print masked startup banner. */
export function printConfigSummary(cfg: AppConfig = loadConfig()): void {
  const log = (...a: unknown[]) => console.error("[config]", ...a);
  log("source             = process.env (.env file auto-loaded if present)");
  log("notion.database_id =", cfg.notion.database_id);
  log("notion.token       =", mask(cfg.notion.token, 6, 4));
  log("notion.version     =", cfg.notion.notion_version);
  log("graph_apps_source  =", cfg.graph_apps_source);
  log("graph_apps.count   =", Object.keys(getEffectiveGraphAppsSync(cfg)).length);
  for (const [domain, app] of Object.entries(getEffectiveGraphAppsSync(cfg))) {
    log(
      `  - ${domain}: tenant=${app.tenant_id} client=${app.client_id} secret=${mask(app.client_secret)}`,
    );
  }
  log("graph.scopes       =", cfg.graph_defaults.scopes.join(","));
  log("graph.authority    =", cfg.graph_defaults.authority);
  log("mailboxes          = (managed in DB; see `mailboxes` table in Supabase)");
  log("folders            =", cfg.folders.join(","));
  log("polling            =", JSON.stringify(cfg.polling));
  log("postgres.url       =", maskUrl(cfg.postgres.url));
  log("postgres.max_pool  =", cfg.postgres.max_pool);
  log("redis              =", `${cfg.redis.host}:${cfg.redis.port}/db${cfg.redis.db}`);
  log("server             =", `${cfg.server.host}:${cfg.server.port}`);
  log("logging            =", JSON.stringify(cfg.logging));
  log("v2.enabled         =", cfg.v2.enabled);
  log("v2.public_base_url =", cfg.v2.public_base_url || "(empty)");
  log("v2.webhook_path    =", cfg.v2.webhook_path);
  log("v2.client_state    =", cfg.v2.enabled ? mask(cfg.v2.subscription_client_state_secret, 4, 2) : "(n/a)");
  log("v2.disable_poll    =", cfg.v2.disable_polling_when_v2);
  log("v2.delta_interval_ms=", cfg.v2.delta_sync_interval_ms);
  log("admin.ui_enabled     =", cfg.admin.enabled);
  log("mail.opt_out_footer  =", cfg.mail.opt_out_footer_text.slice(0, 48) + (cfg.mail.opt_out_footer_text.length > 48 ? "…" : ""));
  log("mail.unsub_path      =", cfg.mail.list_unsubscribe_path);
  log("mail.unsub_secret    =", mask(cfg.mail.list_unsubscribe_token_secret, 4, 2));
}

/** Test helper: drop the cached config so the next `loadConfig` re-reads env. */
export function _resetConfigCacheForTests(): void {
  cached = null;
  envLoaded = false;
}
