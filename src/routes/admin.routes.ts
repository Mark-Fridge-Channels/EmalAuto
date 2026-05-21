/**
 * Admin web console JSON API + session auth.
 */

import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { adminSessionPluginOptions } from "../auth/admin-session.js";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { and, desc, eq, gte, ilike, lt, or, sql, count, type SQL } from "drizzle-orm";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { refreshGraphAppsFromDb } from "../services/graph-apps.service.js";
import * as graphAppsRepo from "../db/repositories/graph-apps.repo.js";
import * as mailboxRepo from "../db/repositories/mailbox.repo.js";
import { findInboxById, listInboxForAdmin } from "../db/repositories/inbox.repo.js";
import { listOutboundForAdmin } from "../db/repositories/outbound.repo.js";
import { findMailboxById } from "../db/repositories/mailbox.repo.js";
import { GraphApiError } from "../graph/client.js";
import { getMessageFullForAdmin, downloadAttachmentBytes } from "../graph/mail.service.js";
import { executeAdminInboxReply } from "../services/admin-reply.service.js";
import { buildSystemStatus } from "../services/system-status.service.js";
import { db } from "../db/client.js";
import { outboundMessages } from "../db/schema/outbound_messages.js";
import { inboxMessages } from "../db/schema/inbox_messages.js";
import { sendQueue } from "../queues/queues.js";
import { mailboxes } from "../db/schema/mailboxes.js";
type AdminSession = { admin?: boolean };

type CrmSeed = {
  entityName: string | null;
  keyPersonId: string | null;
  keyPersonName: string | null;
};

/** Case-insensitive substring match without SQL LIKE wildcards (`%` / `_` in names). */
function containsCi(column: { name: string }, needle: string): SQL {
  const n = needle.toLowerCase();
  return sql`position(${n} in lower(coalesce(${column}, ''))) > 0`;
}

/** Match any inbox/outbound row that shares CRM dimensions with the seed row. */
function buildCrmOrWhere(
  seed: CrmSeed,
  table: typeof inboxMessages | typeof outboundMessages,
): SQL {
  const parts: SQL[] = [];
  const ent = seed.entityName?.trim();
  const kpId = seed.keyPersonId?.trim();
  const kpName = seed.keyPersonName?.trim();
  if (ent) parts.push(containsCi(table.entityName, ent));
  if (kpId) parts.push(eq(table.keyPersonId, kpId));
  if (kpName) parts.push(containsCi(table.keyPersonName, kpName));
  if (parts.length === 0) return sql`1 = 0`;
  if (parts.length === 1) return parts[0]!;
  return or(...parts)!;
}

function sessionAdmin(req: FastifyRequest): boolean {
  return Boolean((req.session as AdminSession).admin);
}

/** `{ to: string[], cc?: string[] }` → comma-separated To addresses for timeline UI. */
function formatToRecipients(recipientsJson: unknown): string {
  if (!recipientsJson || typeof recipientsJson !== "object") return "";
  const o = recipientsJson as { to?: unknown; cc?: unknown };
  const parts: string[] = [];
  if (Array.isArray(o.to)) {
    for (const v of o.to) {
      const s = String(v ?? "").trim();
      if (s) parts.push(s);
    }
  } else if (o.to) {
    const s = String(o.to).trim();
    if (s) parts.push(s);
  }
  return parts.join(", ");
}

export async function registerAdminConsole(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.admin.enabled) {
    logger.warn("admin console disabled (set ADMIN_UI_PASSWORD to enable)");
    return;
  }

  await app.register(fastifyCookie);
  await app.register(fastifySession, adminSessionPluginOptions());

  await app.register(
    async (scope) => {
      await scope.register(fastifyRateLimit, {
        max: 30,
        timeWindow: "1 minute",
      });
      scope.post("/login", async (req, reply) => {
        const body = z.object({ password: z.string() }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "invalid body" });
        if (body.data.password !== cfg.admin.ui_password) {
          return reply.code(401).send({ error: "invalid password" });
        }
        (req.session as AdminSession).admin = true;
        await req.session.save();
        return { ok: true };
      });
    },
    { prefix: "/api/auth" },
  );

  await app.register(
    async (scope) => {
      scope.addHook("preHandler", async (req, reply) => {
        if (!sessionAdmin(req)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      });

      scope.post("/logout", async (req) => {
        await req.session.destroy();
        return { ok: true };
      });

      scope.get("/me", async () => ({ ok: true, role: "admin" }));

      scope.get("/system/status", async () => buildSystemStatus());

      scope.get("/dashboard", async (req) => {
        const q = z
          .object({
            domain: z.string().optional(),
            email: z.string().optional(),
          })
          .parse(req.query);

        const domainTrim = q.domain?.trim().toLowerCase();
        const emailTrim = q.email?.trim().toLowerCase();
        const mailboxFilters: SQL[] = [];
        if (domainTrim) {
          mailboxFilters.push(ilike(mailboxes.email, `%@${domainTrim}`));
        }
        if (emailTrim) {
          mailboxFilters.push(ilike(mailboxes.email, `%${emailTrim}%`));
        }
        const mailboxScope = mailboxFilters.length ? and(...mailboxFilters) : undefined;

        const now = new Date();
        const startYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
        const endYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000);

        const yWindow = and(
          gte(outboundMessages.sentAt, startYesterday),
          lt(outboundMessages.sentAt, endYesterday),
        );
        const yScope = mailboxScope ? and(yWindow, mailboxScope) : yWindow;

        const [yTotalRow] = await db
          .select({ c: count() })
          .from(outboundMessages)
          .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
          .where(yScope);
        const [yFailRow] = await db
          .select({ c: count() })
          .from(outboundMessages)
          .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
          .where(and(yScope, eq(outboundMessages.threadStatus, "failed")));

        const yTotal = yTotalRow?.c ?? 0;
        const yFailed = yFailRow?.c ?? 0;
        /** Rows with `thread_status=failed` are a subset of all rows in the window — never add counts. */
        const threadSuccessRate = yTotal > 0 ? (yTotal - yFailed) / yTotal : null;

        const counts = await sendQueue.getJobCounts("waiting", "delayed", "active");
        const pendingSendQueue = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);

        const s30Base = gte(outboundMessages.sentAt, thirtyDaysAgo);
        const s30Scope = mailboxScope ? and(s30Base, mailboxScope) : s30Base;

        const [replied] = await db
          .select({ c: count() })
          .from(outboundMessages)
          .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
          .where(and(s30Scope, eq(outboundMessages.threadStatus, "reply_received")));

        const [bounced] = await db
          .select({ c: count() })
          .from(outboundMessages)
          .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
          .where(and(s30Scope, eq(outboundMessages.threadStatus, "bounce")));

        const [sent30] = await db
          .select({ c: count() })
          .from(outboundMessages)
          .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
          .where(s30Scope);

        const s30 = sent30?.c ?? 0;
        const replyRate = s30 > 0 ? (replied?.c ?? 0) / s30 : null;
        const bounceRate = s30 > 0 ? (bounced?.c ?? 0) / s30 : null;

        return {
          filters: {
            domain: domainTrim || null,
            email: emailTrim || null,
          },
          yesterday: {
            /** Outbound rows whose `sent_at` fell in yesterday (only created after a successful Graph+PG persist). */
            outboundRecordsTotal: yTotal,
            threadFailed: yFailed,
            /** 1 − failed/total within the window; if no `failed` rows exist in PG this stays 100%. */
            threadSuccessRate: threadSuccessRate,
            caption:
              "说明：outbound 行仅在成功发信并落库后产生；队列失败不会写入 PG。`thread_failed` 需业务写入后「线程成功率」才有区分度。",
          },
          today: { pendingSendQueueJobs: pendingSendQueue },
          last30d: {
            replyRate,
            bounceRate,
            openRate: null as number | null,
            positiveReplyRate: null as number | null,
          },
          v1_metric_gaps: [
            "打开率需要邮件内追踪像素或外部 ESP 事件，当前未采集。",
            "正向回复率以 thread_status=reply_received 计（不含 match_status=auto_reply 的自动回复）。",
            "Notion 回填且无 Graph conversationId 的历史发信，回复率依赖 match worker 的主题/收发人启发式（LEGACY_MATCH_*）；与 conversationId 匹配的新发信逻辑分开。",
            "今日待发送量使用 BullMQ send 队列深度，不含尚未入队的纯 Notion Todo 行；且未按 domain/email 筛选。",
            "昨日与近30天指标在填写筛选条件时，仅统计匹配邮箱（mailboxes.email）的 outbound 行。",
            "昨日「线程成功率」= 1 − failed/total；failed 子集于 total，禁止把两计数相加做分母。",
          ],
        };
      });

      scope.get("/inbox", async (req) => {
        const q = z
          .object({
            entity: z.string().optional(),
            keyPerson: z.string().optional(),
            email: z.string().optional(),
            domain: z.string().optional(),
            receivedFrom: z.string().optional(),
            receivedTo: z.string().optional(),
            matchStatus: z.enum(["matched", "unmatched", "ignored", "bounce", "auto_reply", "all"]).optional(),
            limit: z.coerce.number().min(1).max(200).default(50),
            offset: z.coerce.number().min(0).default(0),
          })
          .parse(req.query);
        const matchStatus = q.matchStatus ?? "matched";
        return listInboxForAdmin({
          entityName: q.entity,
          keyPersonId: q.keyPerson,
          email: q.email,
          domain: q.domain,
          receivedFrom: q.receivedFrom ? new Date(q.receivedFrom) : undefined,
          receivedTo: q.receivedTo ? new Date(q.receivedTo) : undefined,
          matchStatus,
          limit: q.limit,
          offset: q.offset,
          order: "received_desc",
        });
      });

      scope.get("/outbound", async (req) => {
        const q = z
          .object({
            entity: z.string().optional(),
            keyPerson: z.string().optional(),
            notionPageId: z.string().optional(),
            domain: z.string().optional(),
            sentFrom: z.string().optional(),
            sentTo: z.string().optional(),
            limit: z.coerce.number().min(1).max(200).default(50),
            offset: z.coerce.number().min(0).default(0),
          })
          .parse(req.query);
        return listOutboundForAdmin({
          entityName: q.entity,
          keyPersonId: q.keyPerson,
          notionPageId: q.notionPageId,
          domain: q.domain,
          sentFrom: q.sentFrom ? new Date(q.sentFrom) : undefined,
          sentTo: q.sentTo ? new Date(q.sentTo) : undefined,
          limit: q.limit,
          offset: q.offset,
          order: "sent_desc",
        });
      });

      scope.get("/timeline", async (req, reply) => {
        const q = z
          .object({
            /** Preferred: load CRM from this inbox row (same values as the table cell). */
            inboxId: z.coerce.number().int().positive().optional(),
            /** With inboxId: `entity` = only entity_name; `keyperson` = only key person fields. */
            scope: z.enum(["entity", "keyperson"]).optional(),
            entityName: z.string().optional(),
            keyPersonId: z.string().optional(),
            keyPersonName: z.string().optional(),
            limit: z.coerce.number().min(1).max(300).default(100),
          })
          .parse(req.query);
        const entityQ = q.entityName?.trim() ?? "";
        const kpIdQ = q.keyPersonId?.trim() ?? "";
        const kpNameQ = q.keyPersonName?.trim() ?? "";
        const lim = q.limit;

        let inboxWhere: SQL;
        let outWhere: SQL;
        let hint: string | undefined;

        if (q.inboxId) {
          const seed = await findInboxById(q.inboxId);
          if (!seed) {
            return reply.code(404).send({ error: "inbox row not found", items: [] });
          }
          let crm: CrmSeed;
          if (q.scope === "entity") {
            crm = {
              entityName: seed.entityName,
              keyPersonId: null,
              keyPersonName: null,
            };
            if (!crm.entityName?.trim()) {
              hint = "该行 Entity 为空，无法按 Entity 聚合时间线";
            }
          } else if (q.scope === "keyperson") {
            crm = {
              entityName: null,
              keyPersonId: seed.keyPersonId,
              keyPersonName: seed.keyPersonName,
            };
            if (!crm.keyPersonId?.trim() && !crm.keyPersonName?.trim()) {
              hint = "该行 KeyPerson 为空，无法按 KeyPerson 聚合时间线";
            }
          } else {
            crm = {
              entityName: seed.entityName,
              keyPersonId: seed.keyPersonId,
              keyPersonName: seed.keyPersonName,
            };
            if (!crm.entityName?.trim() && !crm.keyPersonId?.trim() && !crm.keyPersonName?.trim()) {
              hint = "该行 inbox 的 Entity / KeyPerson 字段均为空，无法聚合时间线";
            }
          }
          inboxWhere = buildCrmOrWhere(crm, inboxMessages);
          outWhere = buildCrmOrWhere(crm, outboundMessages);
        } else if (entityQ || kpIdQ || kpNameQ) {
          const crm: CrmSeed = {
            entityName: entityQ || null,
            keyPersonId: kpIdQ || null,
            keyPersonName: kpNameQ || null,
          };
          inboxWhere = buildCrmOrWhere(crm, inboxMessages);
          outWhere = buildCrmOrWhere(crm, outboundMessages);
        } else {
          return reply.code(400).send({ error: "inboxId or entityName or keyPersonId or keyPersonName required" });
        }

        const inboxRows = await db
          .select({
            kind: sql<string>`'inbox'`,
            id: inboxMessages.id,
            at: inboxMessages.receivedAt,
            subject: inboxMessages.subject,
            preview: inboxMessages.bodyPreview,
            fromEmail: inboxMessages.fromEmail,
            recipientsJson: inboxMessages.recipientsJson,
          })
          .from(inboxMessages)
          .where(inboxWhere)
          .orderBy(desc(inboxMessages.receivedAt))
          .limit(lim);

        const outRows = await db
          .select({
            kind: sql<string>`'outbound'`,
            id: outboundMessages.id,
            at: outboundMessages.sentAt,
            subject: outboundMessages.subject,
            preview: sql<string>`''`,
            fromEmail: mailboxes.email,
            recipientsJson: outboundMessages.recipientsJson,
          })
          .from(outboundMessages)
          .innerJoin(mailboxes, eq(outboundMessages.mailboxId, mailboxes.id))
          .where(outWhere)
          .orderBy(desc(outboundMessages.sentAt))
          .limit(lim);

        const merged = [...inboxRows, ...outRows]
          .sort((a, b) => {
            const ta = a.at instanceof Date ? a.at.getTime() : new Date(String(a.at)).getTime();
            const tb = b.at instanceof Date ? b.at.getTime() : new Date(String(b.at)).getTime();
            return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
          })
          .slice(0, lim)
          .map((row) => ({
            kind: row.kind,
            id: row.id,
            at: row.at instanceof Date ? row.at.toISOString() : String(row.at ?? ""),
            subject: row.subject ?? "",
            preview: row.preview ?? "",
            fromEmail: String(row.fromEmail ?? "").trim(),
            toEmails: formatToRecipients(row.recipientsJson),
          }));
        return { items: merged, hint };
      });

      scope.get("/inbox/:id/graph-message", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad id" });
        const row = await findInboxById(id);
        if (!row) return reply.code(404).send({ error: "not found" });
        const box = await findMailboxById(row.mailboxId);
        if (!box) return reply.code(404).send({ error: "mailbox" });
        const full = await getMessageFullForAdmin(box.email, row.graphMessageId);
        if (!full) return reply.code(404).send({ error: "graph message missing" });
        return full;
      });

      scope.get("/inbox/:id/attachments/:attId", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const attId = (req.params as { attId: string }).attId;
        const row = await findInboxById(id);
        if (!row) return reply.code(404).send({ error: "not found" });
        const box = await findMailboxById(row.mailboxId);
        if (!box) return reply.code(404).send({ error: "mailbox" });
        try {
          const { buffer, contentType, filename } = await downloadAttachmentBytes({
            mailbox: box.email,
            messageId: row.graphMessageId,
            attachmentId: attId,
          });
          void reply.header("Content-Type", contentType);
          void reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
          return reply.send(buffer);
        } catch (e: unknown) {
          if (e instanceof GraphApiError && e.status === 415) {
            return reply.code(415).send({ error: e.message });
          }
          throw e;
        }
      });

      scope.post("/inbox/:id/reply", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const emailList = z
          .array(z.string().trim().min(3).max(320))
          .max(40)
          .optional()
          .transform((a) => a?.filter(Boolean));
        const body = z
          .object({
            bodyHtml: z.string().min(1).max(400_000),
            subject: z.string().max(2000).optional(),
            cc: emailList,
            bcc: emailList,
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "invalid body" });
        try {
          return await executeAdminInboxReply({
            inboxRowId: id,
            bodyHtml: body.data.bodyHtml,
            subject: body.data.subject,
            cc: body.data.cc,
            bcc: body.data.bcc,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error({ err: e }, "admin reply failed");
          return reply.code(500).send({ error: msg });
        }
      });

      scope.get("/graph-apps", async () => graphAppsRepo.listGraphApps());

      scope.post("/graph-apps", async (req, reply) => {
        const b = z
          .object({
            domain: z.string().min(1),
            tenantId: z.string().min(1),
            clientId: z.string().min(1),
            clientSecret: z.string().min(1),
            enabled: z.boolean().optional(),
          })
          .safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: "invalid body" });
        const row = await graphAppsRepo.insertGraphApp({
          domain: b.data.domain.trim().toLowerCase(),
          tenantId: b.data.tenantId,
          clientId: b.data.clientId,
          clientSecret: b.data.clientSecret,
          enabled: b.data.enabled ?? true,
        });
        await refreshGraphAppsFromDb();
        return row;
      });

      scope.patch("/graph-apps/:id", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const b = z
          .object({
            domain: z.string().optional(),
            tenantId: z.string().optional(),
            clientId: z.string().optional(),
            clientSecret: z.string().optional(),
            enabled: z.boolean().optional(),
          })
          .safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: "invalid body" });
        const patch = { ...b.data };
        if (patch.domain) patch.domain = patch.domain.trim().toLowerCase();
        const row = await graphAppsRepo.updateGraphApp(id, patch);
        if (!row) return reply.code(404).send({ error: "not found" });
        await refreshGraphAppsFromDb();
        return row;
      });

      scope.delete("/graph-apps/:id", async (req) => {
        const id = Number((req.params as { id: string }).id);
        await graphAppsRepo.deleteGraphApp(id);
        await refreshGraphAppsFromDb();
        return { ok: true };
      });

      scope.get("/mailboxes", async () => mailboxRepo.listAllMailboxes());

      scope.patch("/mailboxes/:id", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const b = z
          .object({
            enabled: z.boolean().optional(),
            canSend: z.boolean().optional(),
            canReceive: z.boolean().optional(),
            email: z.string().email().optional(),
          })
          .safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: "invalid body" });
        const [u] = await db
          .update(mailboxes)
          .set({ ...b.data, updatedAt: new Date() })
          .where(eq(mailboxes.id, id))
          .returning();
        if (!u) return reply.code(404).send({ error: "not found" });
        return u;
      });
    },
    { prefix: "/api" },
  );

  const webDist = path.resolve(process.cwd(), "web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/health")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }
}
