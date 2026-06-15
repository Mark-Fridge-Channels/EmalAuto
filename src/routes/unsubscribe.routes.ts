/**
 * RFC 8058 one-click unsubscribe endpoint (Gmail / Outlook POST).
 *
 * Always registered on the API process — uses `V2_PUBLIC_BASE_URL` + token in
 * outbound `List-Unsubscribe` headers (Send Email only).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config/index.js";
import { recordEmailSuppression } from "../db/repositories/email-suppression.repo.js";
import { verifyUnsubscribeToken } from "../services/list-unsubscribe.service.js";
import { logger } from "../utils/logger.js";

function unsubscribePath(cfg: ReturnType<typeof loadConfig>): string {
  const p = cfg.mail.list_unsubscribe_path.trim();
  return p.startsWith("/") ? p : `/${p}`;
}

function isOneClickPost(req: FastifyRequest): boolean {
  const body = req.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const v = (body as Record<string, unknown>)["List-Unsubscribe"];
    if (typeof v === "string" && v.trim().toLowerCase() === "one-click") return true;
  }
  return false;
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

  app.post(path, async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    if (!isOneClickPost(req)) {
      return reply.code(400).type("text/plain").send("expected List-Unsubscribe=One-Click");
    }

    const verified = verifyUnsubscribeToken(req.params.token, cfg.mail.list_unsubscribe_token_secret);
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
  });
}
