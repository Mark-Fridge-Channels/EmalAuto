import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config/index.js";
import { recordEmailSuppression } from "../db/repositories/email-suppression.repo.js";
import { verifyUnsubscribeToken } from "../services/list-unsubscribe.service.js";
import {
  isOneClickUnsubscribeBody,
  parseOneClickUnsubscribeBody,
} from "../services/unsubscribe-post.service.js";
import { logger } from "../utils/logger.js";

function unsubscribePath(cfg: ReturnType<typeof loadConfig>): string {
  const p = cfg.mail.list_unsubscribe_path.trim();
  return p.startsWith("/") ? p : `/${p}`;
}

async function handleUnsubscribeToken(
  token: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const cfg = loadConfig();
  const verified = verifyUnsubscribeToken(token, cfg.mail.list_unsubscribe_token_secret);
  if (!verified.ok) {
    logger.warn({ reason: verified.reason }, "unsubscribe: invalid token");
    return reply.code(400).type("text/plain").send("invalid unsubscribe link");
  }

  const { recipientEmail, notionPageId } = verified.payload;
  const result = await recordEmailSuppression({
    email: recipientEmail,
    notionPageId,
    source: "list_unsubscribe_one_click",
  });

  logger.info(
    {
      email: recipientEmail,
      notionPageId,
      inserted: result.inserted,
      suppressionId: result.id,
    },
    "unsubscribe: one-click opt-out recorded",
  );

  return reply.code(200).type("text/plain").send("ok");
}

export async function registerUnsubscribeRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();
  const path = `${unsubscribePath(cfg)}/:token`;

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = typeof body === "string" ? body : "";
      const params = new URLSearchParams(raw);
      const parsed: Record<string, string> = {};
      for (const [k, v] of params.entries()) parsed[k] = v;
      done(null, parsed);
    },
  );

  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : "";
      if (parseOneClickUnsubscribeBody(req.headers["content-type"], raw)) {
        done(null, { "List-Unsubscribe": "One-Click" });
        return;
      }
      done(null, {});
    },
  );

  app.post(path, async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const raw = typeof req.body === "string" ? req.body : "";
    const ok =
      isOneClickUnsubscribeBody(req.body) ||
      parseOneClickUnsubscribeBody(req.headers["content-type"], raw);
    if (!ok) {
      return reply.code(400).type("text/plain").send("expected List-Unsubscribe=One-Click");
    }
    return handleUnsubscribeToken(req.params.token, reply);
  });

  /** Gmail / validators may probe with GET before showing the inbox chip. */
  app.get(path, async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const cfg = loadConfig();
    const verified = verifyUnsubscribeToken(req.params.token, cfg.mail.list_unsubscribe_token_secret);
    if (!verified.ok) {
      return reply.code(400).type("text/plain").send("invalid unsubscribe link");
    }
    return reply.code(200).type("text/plain").send("ok");
  });
}
