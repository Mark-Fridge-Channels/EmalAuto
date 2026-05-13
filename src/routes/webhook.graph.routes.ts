/**
 * Microsoft Graph mail change notifications (webhook).
 *
 * - `POST ?validationToken=…` → plain-text echo (subscription handshake; Graph
 *   actually sends POST with the token in the query string and an empty
 *   `application/json` body — NOT GET, despite what some docs imply).
 * - `GET  ?validationToken=…` → also accepted (some Graph regions / our own
 *   curl smoke test use GET; harmless to support both).
 * - `POST` JSON body          → enqueue message fetch jobs (202 Accepted)
 *
 * Registered only when `config.v2.enabled === true`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { webhookIngestQueue } from "../queues/queues.js";
import { logger } from "../utils/logger.js";
import { parseFolderFromResource, parseUserKeyFromResource } from "../graph/webhook-resource.util.js";

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function readValidationToken(req: FastifyRequest): string {
  const q = req.query as Record<string, unknown> | undefined;
  const v = q?.validationToken;
  return typeof v === "string" ? v : "";
}

export async function registerGraphWebhookRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();
  const path = cfg.v2.webhook_path.startsWith("/") ? cfg.v2.webhook_path : `/${cfg.v2.webhook_path}`;

  // Graph's handshake POSTs with `Content-Type: application/json` and an empty
  // body. Fastify's default JSON parser rejects that with 400, which Graph
  // interprets as "endpoint unreachable" → ValidationError. Treat empty bodies
  // as `{}` for this route.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const s = typeof body === "string" ? body.trim() : "";
      if (s.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get(path, async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readValidationToken(req);
    if (!token) {
      return reply.code(400).type("text/plain").send("missing validationToken");
    }
    return reply.code(200).type("text/plain").send(token);
  });

  app.post(path, async (req: FastifyRequest, reply: FastifyReply) => {
    // Graph subscription validation: respond with the raw token in text/plain.
    const token = readValidationToken(req);
    if (token) {
      return reply.code(200).type("text/plain").send(token);
    }

    const secret = cfg.v2.subscription_client_state_secret;
    const body = req.body as { value?: unknown[] } | undefined;
    const value = Array.isArray(body?.value) ? body!.value : [];

    for (const raw of value) {
      const n = raw as Record<string, unknown>;
      const clientState = typeof n.clientState === "string" ? n.clientState : "";
      if (!timingSafeStringEqual(clientState, secret)) {
        logger.warn({ clientStateLen: clientState.length }, "graph webhook: rejected (clientState mismatch)");
        continue;
      }
      const resource = typeof n.resource === "string" ? n.resource : "";
      const resourceData = n.resourceData as Record<string, unknown> | undefined;
      const messageId = typeof resourceData?.id === "string" ? resourceData.id : "";
      const userKey = parseUserKeyFromResource(resource);
      const folder = parseFolderFromResource(resource) ?? "inbox";
      if (!userKey || !messageId) {
        logger.warn({ resource }, "graph webhook: skip — could not parse user/message id");
        continue;
      }
      await webhookIngestQueue.add(
        "webhook-ingest",
        { mailboxEmail: userKey, messageId, folder },
        { jobId: `wh__${userKey}__${messageId}` },
      );
    }

    // Graph expects a quick 202 — processing happens asynchronously.
    return reply.code(202).send();
  });

  logger.info({ path }, "Graph webhook routes registered");
}
