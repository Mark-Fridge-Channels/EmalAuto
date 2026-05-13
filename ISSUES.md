# M365 Mail Orchestration System — Issues

> 基于 `项目文档说明.md`。
> 结构：**1 个 Epic + 8 个 Phase 子任务**（Phase 1-7 = 第一版，Phase 8 = 第二版）。
> 详细执行计划见 `PLAN.md`。

---

## EPIC-001 · M365 多邮箱邮件编排系统（V1 + V2）

**Type**: Epic · **Priority**: High · **Effort**: XL（预估 4-6 周）

### TL;DR
基于 Microsoft Graph **App-only** 鉴权，构建 Conversation-aware Mail Infrastructure：从 `minimal-server` 既有 Notion 库读取发信任务，调用 Graph 发信、轮询收件、按 `conversationId` 匹配回复、识别退信，并把结果回写**同一个 Notion 库**。

### 当前状态
- 仅有 PRD（`项目文档说明.md`）+ 执行计划（`PLAN.md`）
- 无代码、无 Azure App、无 PG/Redis 部署、Notion 库已存在（与 `minimal-server` 共用）

### 期望产出
- **V1（Polling-first）**：OAuth(App-only) → 发信 → metadata 持久化 → Inbox Polling(inbox+junkemail) → Reply Matching → Bounce Detection → Notion 回写
- **V2**：升级为 Webhook + Delta Query

### 技术栈（已确认）
- **Backend**: Node.js + TypeScript
- **Web**: Fastify
- **Queue**: BullMQ + Redis
- **DB**: PostgreSQL（高频）+ Notion（业务视图与任务源）
- **SDK**: `@microsoft/microsoft-graph-client`、`@azure/msal-node`、`@notionhq/client`

### 整体架构
```
Notion DB ─┐
           ├─► Notion Poller ─► BullMQ/Redis ─┬─► Send Worker  ──► Graph API ─► Exchange Online
           │                                    └─► Inbox Worker ──► Graph API ─► Exchange Online
           └◄────────── Notion Sync Writer ◄──── Reply / Bounce Matcher
```

### 子任务（8 个 Phase）
- [ ] **PHASE-001** · OAuth（App-only / Client Credentials）
- [ ] **PHASE-002** · Graph 发信
- [ ] **PHASE-003** · Message Metadata 持久化
- [ ] **PHASE-004** · Inbox Polling（inbox + junkemail）
- [ ] **PHASE-005** · Reply Matching（conversationId 核心）
- [ ] **PHASE-006** · Bounce Detection（启发式）
- [ ] **PHASE-007** · Notion 双向同步（沿用 minimal-server 既有列）
- [x] **PHASE-008** · Webhook + Delta Query（V2）

### 风险 & 注意
- `conversationId` 是整个系统最重要字段，所有发信必须落 `outbound_messages`
- **V1 建议**以 Polling 为主；**V2** 通过 `config.v2.enabled` 启用 Webhook + Delta；生产仍建议保留轮询兜底（勿随意 `disable_polling_when_v2`）
- App-only token 由 MSAL 缓存自动刷新，**不**按邮箱存 refresh token
- Notion API 限流（≈ 3 req/s），写回需节流；列名/类型变更先改 `notion_property_names` 配置而不是改代码
- Notion 列类型 `status` 与 `select` 都要兼容（沿用 `minimal-server` 双兼容做法）
- V2 不需要额外 Application 权限（Graph 订阅与 Delta 都被 `Mail.Read`/`Mail.ReadWrite` 隐含）；但 `public_base_url` 必须 **HTTPS** 公网可达

---

## PHASE-001 · OAuth 模块（App-only）

**Type**: Feature · **Priority**: High · **Effort**: M · **Depends on**: 无

### TL;DR
**每个邮件域名 = 独立 Microsoft 365 租户 = 独立 Azure App**。`config.graph_apps[<domain>]` 记录每个 App 的 `tenant_id` / `client_id` / `client_secret`；mailbox 按邮箱后缀解析对应 App；MSAL `ConfidentialClientApplication` 按 App key 缓存。

### 当前 → 期望
| 当前 | 期望 |
| --- | --- |
| 无 Azure App | 每个域名都注册一个 Single Tenant App，已 admin consent Application 权限（`Mail.Send`、`Mail.ReadWrite`；V2 也无需额外 Subscription 权限） |
| 无 token 机制 | MSAL 客户端凭证流，**按 App key 分别缓存** |
| 无 mailbox 表 | `mailboxes` 表只存：`id / email(UPN) / enabled / can_send / can_receive / inbox_last_sync_at / junk_last_sync_at` |

### 必须权限（每个 App 都要授）
```
Mail.Send  (Application)
Mail.ReadWrite  (Application)        # 至少 Mail.Read，含其他文件夹要 ReadWrite/Read
# Webhook + Delta (V2) 不需要额外的 Subscription.* 权限 —— 由对资源的读权限隐含授予
```
> **不**使用 `offline_access` / `User.Read`，那是 Delegated 流程。

### 凭据载体（默认）
- `client_secret`（写 `config.json` 的 `graph_apps[<domain>].client_secret`）
- 后续可选改成证书（MSAL 屏蔽差异）

### 涉及文件 / 模块
- `src/config/index.ts` — `graph_apps` schema + `resolveAppKeyForMailbox`
- `src/auth/msal.ts` — per-app `ConfidentialClientApplication` + `acquireGraphTokenForMailbox` / `acquireGraphTokenForApp`
- `src/auth/token-cache.warmer.ts` — 枚举所有 App 周期 warm
- `src/graph/client.ts` — `graphFetch{,Absolute}` 必带 `actorMailbox`
- `src/db/repositories/mailbox.repo.ts` — 同步配置时跳过无匹配 App 的 mailbox
- `src/routes/health.routes.ts` — 按 App 暴露 token 健康

### 风险
- App-only 下 `users/{email}/sendMail` 仍要求 mailbox 在该 App 所属 tenant，且 App 已 admin consent
- 同一域名误填到多个 `graph_apps` 键会被 zod 拒绝（key 必须小写、唯一）

---

## PHASE-002 · Graph 发信

**Type**: Feature · **Priority**: High · **Effort**: M · **Depends on**: PHASE-001

### TL;DR
Notion Poller 从既有 Notion 库筛选 `OutReach Status = Todo` 且 `Action ∈ {Send Email, Reply Email}` 且 `Platform = Email` 且 `InNOut = Out` 的行，进 `send` 队列；Send Worker 调 `POST /users/{email}/sendMail` 发 HTML body。

### Notion 字段映射（与 minimal-server 一致）
| 语义键 | 实际列名 | 类型 |
| --- | --- | --- |
| Status | `OutReach Status` | status |
| Action | `Action` | select |
| Platform | `Platform` | select |
| InNOut | `InNOut` | select |
| sender_email | `FCAccount` | rich_text |
| subject | `Outreach Subject` | rich_text |
| body | `Outreach Body` | rich_text（含 HTML 转换） |
| payload | `Payload` | rich_text（JSON） |
| reply_email | `Reply Email` | email |

### 当前 → 期望
| 当前 | 期望 |
| --- | --- |
| 无发信能力 | Send Worker 消费 `send` 队列，幂等键 = Notion `page_id` |
| 无任务模型 | Notion 行被读 → 写 `OutReach Status=sending` → 真实发信 → 写 `Success/Failure` |

### 涉及文件 / 模块
- `src/workers/send.worker.ts`
- `src/services/graph.service.ts`
- `src/queues/send.queue.ts`
- `src/notion/poller.ts`

### 风险
- 附件超 3MB 必须 `createUploadSession`（V1 不实现，minimal-server 也无附件）
- 单 mailbox 限频：M365 默认 30 msg/min、10000/day

---

## PHASE-003 · Message Metadata 持久化

**Type**: Feature · **Priority**: High · **Effort**: S · **Depends on**: PHASE-002

### TL;DR
发信成功后保存 Graph 元数据到 PG `outbound_messages`，并把 `_graph` 段合并写回 Notion `Payload` JSON。

### PG 表 `outbound_messages`
```
id / mailbox_id / notion_page_id / graph_message_id /
conversation_id / internet_message_id /
subject / sent_at / recipients_json / created_at
```
索引：`conversation_id`、`(mailbox_id, sent_at)`、`notion_page_id`

### 涉及文件 / 模块
- `src/db/schema/outbound_messages.ts`
- `src/services/message-store.service.ts`

### 风险
- `conversationId` 缺失则 Reply Matching 全失效
- `sendMail` 不直接返 `internetMessageId`，需 `GET /messages/{id}?$select=internetMessageId,conversationId` 二次拿

---

## PHASE-004 · Inbox Polling

**Type**: Feature · **Priority**: High · **Effort**: M · **Depends on**: PHASE-001

### TL;DR
每 mailbox × 每 folder 每 30 秒调用 `GET /users/{email}/mailFolders/{folderId}/messages?$filter=receivedDateTime gt {last_sync}` 拉新邮件，写 `inbox_messages`。

### 文件夹（可配，默认）
```
['inbox', 'junkemail']
```

### 涉及文件 / 模块
- `src/workers/inbox.worker.ts`
- `src/queues/inbox.queue.ts`
- `src/db/schema/inbox_messages.ts`

### 风险
- Graph 返回 UTC，统一 UTC 存储与比较
- 429 必须指数退避
- V1 **不要** webhook

---

## PHASE-005 · Reply Matching（核心）

**Type**: Feature · **Priority**: Critical · **Effort**: M · **Depends on**: PHASE-003, PHASE-004

### TL;DR
新收邮件用 `conversationId` 命中 `outbound_messages`，命中即 Reply。CC 回复、同域回复因共享 `conversationId` 自然命中。**禁止 `from == recipient` 弱匹配**。

### 涉及文件 / 模块
- `src/services/reply-matcher.service.ts`
- `src/db/schema/conversation_map.ts`

### 风险
- 跨 tenant 回复 `conversationId` 不一致 → V1 仅日志告警，兜底用 `In-Reply-To` / `References` 留 V1.5
- 同 conversation 多次回复，取最新一条作 `latest_reply`

---

## PHASE-006 · Bounce Detection

**Type**: Feature · **Priority**: High · **Effort**: S · **Depends on**: PHASE-004

### TL;DR
退信本质是普通邮件，启发式判定：

- **from** 含 `MAILER-DAEMON` / `postmaster@`
- **subject** 含 `Undeliverable` / `Delivery Status Notification` / `Returned mail` / `Mail delivery failed` / `无法投递`
- 命中后从 body / `messages/{id}/$value` MIME 抽 `internetMessageId` 关联回 `outbound_messages`

### 涉及文件 / 模块
- `src/services/bounce-detector.service.ts`

### 风险
- 各服务商退信格式不同 → 规则可扩展
- 中/日文退信主题需兜底关键词

---

## PHASE-007 · Notion 双向同步

**Type**: Feature · **Priority**: High · **Effort**: M · **Depends on**: PHASE-002, PHASE-005, PHASE-006

### TL;DR
- **入向**：Poller 读 Notion 既有库（`OutReach Status = Todo`、`Action ∈ {...}`），10–20 s 一次
- **出向**：sent / reply / bounce / failed 回写到**同一行**

### 出向写回字段（沿用 minimal-server 列）
| 场景 | 写入列 |
| --- | --- |
| 发送成功 | `OutReach Status = Success` + `Completion Time` + `Payload._graph` |
| 收到回复 | `Reply Body` + `Reply Email`（email 类型） + `Last Reply Time`（Asia/Shanghai +08:00） + 可选 `Reply Status` |
| 退信 | `OutReach Status = Failure` + `Result Remark = bounce_reason` + `Payload._graph.bounce` |
| 发送失败 | `OutReach Status = Failure` + `Result Remark = error message` |

### 涉及文件 / 模块
- `src/notion/client.ts` — 含 429 退避 / status·select 双兼容（参考 `minimal-server/notion.js`）
- `src/notion/property-mapper.ts` — `notion_property_names` 解析（参考 `minimal-server/queueParser.js`）
- `src/notion/writer.ts`
- `src/notion/poller.ts`

### 风险
- Notion 限流 ≈ 3 req/s → 客户端层串行 + 指数退避
- rich_text 单段 ≈ 2000 字符上限 → 写入前截断到 1900（minimal-server 同样做法）
- 列名/类型变更只改 `config.notion_property_names`，不改代码

---

## PHASE-008 · Webhook + Delta Query（V2）

**Type**: Improvement · **Priority**: Medium · **Effort**: L · **Depends on**: V1 全部完成

### TL;DR
Inbox Polling 升级为 Microsoft Graph Change Notifications + Delta Query，提升实时性、降低 API 调用量。

### 涉及文件 / 模块
- `src/routes/webhook.graph.routes.ts` — `GET` 校验 token / `POST` 通知入队
- `src/workers/webhook-ingest.worker.ts` — 拉取单条 message 并 ingest
- `src/workers/v2-maintenance.worker.ts` — 订阅创建/续订 + 定时 Delta
- `src/graph/subscription.service.ts` — `POST/PATCH/DELETE /subscriptions`
- `src/graph/delta.service.ts` — `@odata.nextLink` / `@odata.deltaLink` 全量步行
- `src/graph/webhook-resource.util.ts` — 解析 `resource` 中的 mailbox / folder
- `src/graph/client.ts` — `graphFetchAbsolute`
- `src/db/repositories/webhook.repo.ts` — 持久化 `subscription_id` + `delta_link`
- `src/services/inbox-ingest.service.ts` — 轮询 / Delta / Webhook 共用入库

### 风险
- Webhook 必须 HTTPS 公网 + 10s 内响应 validationToken
- 订阅续期失败会丢消息 → 监控告警 + 兜底回退 Polling
- Delta token 过期需全量回填

参考：[Microsoft Graph Change Notifications](https://learn.microsoft.com/graph/change-notifications-delivery-webhooks)

---

## 全局约定

### Notion 行状态机（沿用既有 status 选项；具体名以 Notion 库实际为准）
```
Todo → (in-flight) → Success
                  ↘ → Failure
回复到达后单独写 Reply Body / Reply Email / Last Reply Time
```

### 数据库表清单（PostgreSQL）
- `mailboxes`
- `outbound_messages`
- `inbox_messages`
- `conversation_map`
- `webhook_subscriptions`（V2）

### 不要做的事
- ❌ 在未配置公网 HTTPS 时开启 `v2.enabled`（会创建订阅失败）
- ❌ 多 provider 抽象
- ❌ IMAP / SMTP 抽象层
- ❌ 给 Notion 库新增列（Graph 元数据全塞 `Payload` JSON，与 minimal-server 一致）
- ✅ Graph-only + App-only + **Polling（默认兜底）** + **可选 V2 Webhook/Delta** + ConversationId tracking
