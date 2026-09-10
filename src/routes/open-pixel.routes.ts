import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config/index.js";
import {
  findLatestOutboundIdByNotionPageId,
  recordEmailOpen,
} from "../db/repositories/email-open.repo.js";
import {
  TRANSPARENT_GIF_BYTES,
  hashClientIp,
  verifyOpenTrackToken,
} from "../services/open-tracking.service.js";
import { logger } from "../utils/logger.js";

function openPath(cfg: ReturnType<typeof loadConfig>): string {
  const p = cfg.mail.open_tracking_path.trim();
  return p.startsWith("/") ? p : `/${p}`;
}

function stripGifSuffix(tokenParam: string): string {
  const t = decodeURIComponent(tokenParam.trim());
  return t.replace(/\.gif$/i, "");
}

async function handleOpenPixel(
  tokenParam: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const cfg = loadConfig();
  const token = stripGifSuffix(tokenParam);
  const verified = verifyOpenTrackToken(token, cfg.mail.list_unsubscribe_token_secret);

  // Always return a GIF so clients / scanners do not retry aggressively on 4xx.
  const sendGif = () =>
    reply
      .code(200)
      .header("Content-Type", "image/gif")
      .header("Cache-Control", "no-store, no-cache, must-revalidate, private")
      .header("Pragma", "no-cache")
      .send(TRANSPARENT_GIF_BYTES);

  if (!verified.ok) {
    logger.debug({ reason: verified.reason }, "open-pixel: invalid token");
    return sendGif();
  }

  if (!cfg.mail.open_tracking_enabled) {
    return sendGif();
  }

  const { recipientEmail, notionPageId } = verified.payload;
  try {
    const outboundId = await findLatestOutboundIdByNotionPageId(notionPageId);
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : null) || req.ip;
    const ipHash = hashClientIp(ip, cfg.mail.list_unsubscribe_token_secret);
    const recorded = await recordEmailOpen({
      email: recipientEmail,
      notionPageId,
      outboundId,
      userAgent: ua,
      ipHash,
    });
    logger.info(
      {
        openId: recorded.id,
        email: recipientEmail,
        notionPageId,
        outboundId,
      },
      "open-pixel: open recorded",
    );
  } catch (err) {
    logger.error({ err, notionPageId, email: recipientEmail }, "open-pixel: record failed");
  }

  return sendGif();
}

export async function registerOpenPixelRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();
  const path = `${openPath(cfg)}/:token`;

  app.get(path, async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    return handleOpenPixel(req.params.token, req, reply);
  });
}
