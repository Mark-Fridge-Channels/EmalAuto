/**
 * Admin UI session: persisted in Redis so login survives API restarts.
 *
 * Previously sessions were in-memory only + cookie maxAge was effectively ~10 minutes
 * (seconds passed where milliseconds are required).
 */

import { RedisStore } from "connect-redis";
import { Redis } from "ioredis";
import type { FastifySessionOptions } from "@fastify/session";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

let store: RedisStore | undefined;
let redisClient: Redis | undefined;

export function getAdminSessionStore(): RedisStore {
  if (store) return store;
  const cfg = loadConfig();
  redisClient = new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password || undefined,
    db: cfg.redis.db,
  });
  redisClient.on("error", (err) => logger.error({ err }, "admin session redis error"));

  const ttlSec = Math.max(60, Math.ceil(cfg.admin.session_max_age_ms / 1000));
  store = new RedisStore({
    client: redisClient,
    prefix: "emalauto:sess:",
    ttl: ttlSec,
  });
  logger.info(
    { redisDb: cfg.redis.db, ttlSec, maxAgeMs: cfg.admin.session_max_age_ms },
    "admin session store: redis",
  );
  return store;
}

export function adminSessionPluginOptions(): FastifySessionOptions {
  const cfg = loadConfig();
  return {
    secret: cfg.admin.session_secret,
    cookieName: "emalauto_admin",
    store: getAdminSessionStore(),
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: cfg.admin.session_max_age_ms,
    },
  };
}
