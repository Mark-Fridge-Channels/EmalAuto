# M365 Mail Orchestration System — Implementation Plan

**Overall Progress:** `100%`

## TLDR
基于 Microsoft Graph App-only 鉴权，构建多邮箱邮件编排系统：从 `minimal-server` 现有的 Notion 库读取发信任务，用 Graph API 发信、**轮询 + 可选 V2（Webhook + Delta）** 收件、按 `conversationId` 匹配回复、识别退信，并把结果回写**同一个 Notion 库**。流程对齐 `项目文档说明.md`（含第二版 Webhook + Delta）。

---

## Critical Decisions

- **Notion 库**：直接对接 `minimal-server` 已有 Notion 库（用户选 2）；列名沿用既有字段（`OutReach Status / Reply Status / FCAccount / Outreach Subject / Outreach Body / Payload / Completion Time / Reply Body / Reply Email / Last Reply Time / Result Remark / Task ID / Action / Platform / InNOut`），不为本项目新增列。
- **Graph 元数据落地**：`conversation_id / internet_message_id / sent_message_id / bounce 标记 / thread_status` 在 **Notion 侧统一写回 `Payload`（JSON 字符串）**（与 minimal-server 同一约定），主存仍是 PostgreSQL。
- **Notion 字段映射机制**：复用 `minimal-server/config.example.json` 的 `notion_property_names` 模式（语义键 → 实际列名），加上 `queueParser.js` 的 key alias 容错读取与 `select`/`status` 类型双兼容。
- **认证**：App-only（MSAL `ConfidentialClientApplication` + `client_credentials`，scope `https://graph.microsoft.com/.default`），单 Azure App + tenant admin consent；token 进程内缓存，**不**按邮箱存 refresh token。
- **凭据载体（默认假设）**：开发用 `client_secret`，生产用证书；MSAL 屏蔽差异。
- **租户**：Single tenant。
- **收件文件夹**：可配 well-known 列表，默认 `['inbox','junkemail']`。
- **轮询节奏**（来自 `项目文档说明.md`）：Notion 任务 10–20 s，邮箱收件 30 s/邮箱。
- **技术栈**：Node.js + TypeScript、Fastify、BullMQ + Redis、PostgreSQL；Notion 用 `@notionhq/client` 但自带 429 退避与速率限制（沿用 `minimal-server/notion.js` 思路）。
- **V1 默认**：只做 Polling；**V2** 通过 `v2.enabled` 启用 Webhook + Delta（见 `README.md` §7）

---

## Tasks

- [x] 🟩 **Step 0: 校准 ISSUES.md 与新决策对齐**
  - [x] 🟩 删除 ISSUES.md 中对长文档的引用，仅留 `项目文档说明.md`
  - [x] 🟩 PHASE-001 由「OAuth Authorization Code + offline_access + 每邮箱 refresh token」改为「App-only / Client Credentials」
  - [x] 🟩 将 PHASE-007（Notion 同步）的字段集改为 minimal-server 实际列名
  - [x] 🟩 在 EPIC-001「风险」追加：Notion 列名/类型变更需先改 `notion_property_names` 配置

- [x] 🟩 **Step 1: 项目脚手架与公共基础**
  - [x] 🟩 单 repo + TypeScript（`package.json` / `tsconfig.json` / `.editorconfig` / `.gitignore`）
  - [x] 🟩 安装依赖：`fastify` `@microsoft/microsoft-graph-client` `@azure/msal-node` `@notionhq/client` `bullmq` `ioredis` `pg` `drizzle-orm` `drizzle-kit` `zod` `pino` `dotenv`
  - [x] 🟩 目录结构：`src/{config,auth,graph,notion,workers,queues,db,routes,services,utils}`
  - [x] 🟩 `config.example.json` 草稿
  - [x] 🟩 启动 banner，token 脱敏

- [x] 🟩 **Step 2: Notion 配置与字段映射模块**
  - [x] 🟩 `property_names` 默认值（与 minimal-server 一致）+ 用户覆盖合并（`config/index.ts`）
  - [x] 🟩 启动校验：`retrieveDatabase` 检查必填语义键的列存在 + 类型匹配（`notion/schema-validator.ts`）
  - [x] 🟩 读侧工具：`firstDefined / readSelectOrStatus / readRichText / readEmail / readFormulaText / richTextPropertyToHtml` (`notion/property-mapper.ts`)
  - [x] 🟩 写侧工具：`notionStatus / notionSelect / notionRichText / notionDate / notionDateTimeAsiaShanghai / notionTitle / notionEmail / statusOrSelect`，1900 字符截断
  - [x] 🟩 速率限制：客户端层串行 + 429 指数退避（`notion/client.ts`）

- [x] 🟩 **Step 3: OAuth 模块（App-only）**
  - [x] 🟩 MSAL `ConfidentialClientApplication` + `acquireTokenByClientCredential` 缓存（`auth/msal.ts`）
  - [x] 🟩 401 时强制刷新 + 健康检查暴露 `peekCachedToken`
  - [x] 🟩 `auth/token-cache.warmer.ts` 周期预热（半 `token_warm_skew_ms` 节拍）
  - [x] 🟩 `mailboxes` 表：仅存 id/email/enabled/can_send/can_receive/两个 folder 游标
  - [x] 🟩 mailbox 来源：`config.json` 的 `mailboxes[]`，启动时 `syncMailboxesFromConfig` upsert

- [x] 🟩 **Step 4: Mail Send Worker**
  - [x] 🟩 Notion Poller：`notion/poller.ts` 过滤 `OutReach Status=Todo & Action ∈ {Send,Reply} & Platform=Email & InNOut=Out`，并支持 `status`/`select` 双类型
  - [x] 🟩 BullMQ `jobId = send:{notionPageId}` 幂等
  - [x] 🟩 任务装配：`services/job-builder.service.ts`（`FCAccount/Outreach Subject/Outreach Body→HTML/Payload+Reply Email`）
  - [x] 🟩 Send Worker：`workers/send.worker.ts` 调 `graph/mail.sendMail`，先 `markSending` 再发
  - [x] 🟩 附件 V1 不实现（已在 README 注明 V1.5）

- [x] 🟩 **Step 5: Graph 元数据持久化**
  - [x] 🟩 `outbound_messages` 表（drizzle schema + 索引）
  - [x] 🟩 `findRecentSentMessage` 二次查询拿 `internetMessageId/conversationId`
  - [x] 🟩 `writeSendSuccess` 将 `_graph` 合并到 Notion `Payload` JSON
  - [x] 🟩 完成时写 `OutReach Status = Success` + `Completion Time`

- [x] 🟩 **Step 6: Inbox Polling Worker**
  - [x] 🟩 `inbox.worker.startInboxScheduler` 每 30 s 给每 mailbox × 每 folder 入队 `poll:{boxId}:{folder}`
  - [x] 🟩 Graph：`GET /users/{email}/mailFolders/{folder}/messages` 带 `$filter=receivedDateTime gt cursor`、`$select` 限字段、`$top=50`
  - [x] 🟩 `inbox_messages` 表（唯一索引 `(mailbox_id, graph_message_id)`，写入冲突静默）
  - [x] 🟩 取本批 MAX(`receivedDateTime`) 推进 `mailboxes.{folder}_last_sync_at`；429 退避来自 `graph/client.ts`
  - [x] 🟩 写入新行后投递到 `match` 队列

- [x] 🟩 **Step 7: Reply Matching**
  - [x] 🟩 `services/reply-matcher.matchInboundByConversation`：用 `conversation_id` 查 `outbound_messages`，多对一取最新 outbound
  - [x] 🟩 写 `conversation_map(conversation_id → notion_page_id, latest_inbox_id)`
  - [x] 🟩 不使用 `from == recipient`
  - [x] 🟩 跨 tenant 边界：未命中且为 bounce 时写 warn 日志（兜底 In-Reply-To/References 留 V1.5）

- [x] 🟩 **Step 8: Bounce Detection**
  - [x] 🟩 `services/bounce-detector.detectBounce`：from + subject 短路规则（EN/zh-CN/zh-TW/ja）
  - [x] 🟩 命中且能匹配回 outbound：`markOutboundBounce` + `markInboxMatched(..., "bounce")`
  - [x] 🟩 `writeBounce` 写 `OutReach Status=Failure` + `Result Remark` + `Payload._graph_bounce`

- [x] 🟩 **Step 9: Notion 回写器**
  - [x] 🟩 回复：`Reply Body`（1900 截断）+ `Reply Email`（email + 规范化小写）+ `Last Reply Time`（Asia/Shanghai +08:00）
  - [x] 🟩 退信：见 Step 8
  - [x] 🟩 `getPage` 读列类型，`statusOrSelect` 自适应
  - [x] 🟩 失败：BullMQ `attempts: 3 + exponential backoff`；最终失败由 worker 日志告警

- [x] 🟩 **Step 10: 配置与运行文档**
  - [x] 🟩 `config.example.json` 完整段落 + 行内 `_comment`
  - [x] 🟩 `README.md`：Azure App 注册、PG/Redis 启动、`npm run dev` / `npm run dev:worker`
  - [x] 🟩 健康检查 `GET /health`（PG / Redis / Notion / Graph）

- [x] 🟩 **Step 11（V2）: Webhook + Delta Query**
  - [x] 🟩 PG `webhook_subscriptions` 含 `folder` + `(mailbox_id, folder)` 唯一索引（`scripts/full-schema.sql` / `patch-v2-webhook-folder.sql`）
  - [x] 🟩 Fastify `GET/POST` `webhook_path`：`validationToken` 纯文本回显；`POST` 校验 `clientState` 并入队 `webhook-ingest`
  - [x] 🟩 Worker：每小时续订订阅 + 按 `delta_sync_interval_ms` 跑 Delta；启动时 `bootstrapV2Once`
  - [x] 🟩 `graphFetchAbsolute` 跟随 `@odata.nextLink` / 保存 `@odata.deltaLink`；轮询可通过 `disable_polling_when_v2` 关闭

---

## Phase ↔ Step 对照（与 ISSUES.md 对齐）

| ISSUES.md 阶段 | 本 Plan 步骤 |
| --- | --- |
| PHASE-001 OAuth | Step 3 |
| PHASE-002 Graph 发信 | Step 4 |
| PHASE-003 Metadata 持久化 | Step 5 |
| PHASE-004 Inbox Polling | Step 6 |
| PHASE-005 Reply Matching | Step 7 |
| PHASE-006 Bounce Detection | Step 8 |
| PHASE-007 Notion 双向同步 | Step 2 + Step 4 + Step 9 |
| PHASE-008（V2）Webhook + Delta | Step 11 |

---

## 不在本计划范围

- 长文档里的 MailProvider 抽象层 / Reply-To Alias / Web 管理后台 / Relevance Filter / 多 provider — 不做（用户已删除长文档，按短文档为准）。
- 多 tenant、SaaS 化、AI 摘要 — 不做。
- 附件超过 3 MB（`createUploadSession`）— V1 不做。
- 自建文件夹遍历 — V1 仅 `inbox + junkemail`，可配。
