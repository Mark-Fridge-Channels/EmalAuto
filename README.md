# EmalAuto · M365 Mail Orchestration

基于 Microsoft Graph **App-only** 鉴权的多邮箱邮件编排系统。

- **发信** 由 Notion 数据库驱动（沿用 `minimal-server` 同一张库的字段）
- **收信**：默认 **30s 轮询**（`inbox` + `junkemail`）；**V2** 可启用 **Graph Webhook + Delta** 补偿，并可选关闭轮询
- **退信** 用启发式规则识别并回写 Notion

更多细节见：[`项目文档说明.md`](./项目文档说明.md) · [`PLAN.md`](./PLAN.md) · [`ISSUES.md`](./ISSUES.md)

---

## 1. 准备工作

### 1.1 Azure App（**每个域名一次**）

> **架构语义**：一个邮件域名 (`@acme.com`) = 一个独立 Microsoft 365 租户 = 一个独立的 Azure App。
> 系统按 mailbox 邮箱后缀去 `GRAPH_APP_<N>_DOMAIN` 找凭据；找不到则启动时 warn 并跳过该 mailbox。

对**每个**你要操作的域名都做一遍：

1. 用该域名所属租户的管理员账号登录 Entra ID → App registrations → New registration → **Single tenant**
2. **Certificates & secrets**：创建 client secret（项目当前只支持 `client_secret`）
3. **API permissions** → 选择 **Application** 类型（不是 Delegated）：
   - `Mail.Send`
   - `Mail.ReadWrite`（含其他文件夹；若只读 inbox 可降为 `Mail.Read`）
   - **V2（Webhook + Delta）无需额外权限**——`Mail.Read` / `Mail.ReadWrite` 已隐含订阅该资源的能力
4. 点击 **Grant admin consent**
5. 记录该域名的 `tenant_id` / `client_id` / `client_secret`，写入 `.env`：
   ```bash
   GRAPH_APP_1_DOMAIN=acme.com
   GRAPH_APP_1_TENANT_ID=...
   GRAPH_APP_1_CLIENT_ID=...
   GRAPH_APP_1_CLIENT_SECRET=...

   GRAPH_APP_2_DOMAIN=example.org
   GRAPH_APP_2_TENANT_ID=...
   ...
   ```

### 1.2 PostgreSQL + Redis

```bash
# 任选其一：本地 Homebrew / Docker
docker run -d --name emalauto-pg \
  -e POSTGRES_USER=emalauto -e POSTGRES_PASSWORD=emalauto -e POSTGRES_DB=emalauto \
  -p 5432:5432 postgres:16

docker run -d --name emalauto-redis -p 6379:6379 redis:7
```

### 1.2 PostgreSQL + Redis

- **PostgreSQL**：推荐 [Supabase](https://supabase.com)（免运维，免费档够本项目用）；或本地/RDS 等任意 Postgres 14+。
- **Redis**：BullMQ 的硬依赖。本地最快：
  ```bash
  docker run -d --name emalauto-redis -p 6379:6379 redis:7
  ```

### 1.3 Notion

- 复用 `minimal-server` 已有的库（同一个 `database_id`），把 Integration 共享到该 page。
- 字段名若不同，改 `.env` 里的 `NOTION_COL_*` 即可，**不需要改代码**。

---

## 2. 数据库初始化

用 SQL 直接建表（也可以走 Drizzle migrate，见 §4）：

```bash
# Supabase: 用 Studio 的 SQL Editor 粘贴执行 scripts/full-schema.sql
# 本地:
psql "$DATABASE_URL" -f scripts/full-schema.sql
```

已有旧库、仅补 V2 列与索引：

```bash
psql "$DATABASE_URL" -f scripts/patch-v2-webhook-folder.sql
```

---

## 3. 配置（`.env`）

整个应用**只读环境变量**，没有 `config.json`：

```bash
cp .env.example .env
# 编辑 .env 填入真实 token / id / secret
```

关键变量：

| 变量 | 必填 | 含义 |
| --- | --- | --- |
| `NOTION_TOKEN` / `NOTION_DATABASE_ID` | ✅ | 与 minimal-server 同一张库 |
| `NOTION_COL_*` | ✅ | 语义键 → Notion 实际列名映射（含 `Trigger Time` 等，见 `.env.example`） |
| `NOTION_STATUS_*` / `NOTION_ACTION_*` | ✅ | `OutReach Status` 与 `Action` 实际可选值 |
| `GRAPH_APP_<N>_DOMAIN` / `_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` | ✅ | **每个域名一个** Azure App，索引从 1 起；扫描遇到首个缺失的 `_DOMAIN` 即停 |
| `GRAPH_SCOPES` / `GRAPH_AUTHORITY` | ⬜ | 主权云才需改 |
| `mailboxes` 表 | ✅ | 受控邮箱在 Postgres 里维护（Supabase Studio），启动时审计是否与 `GRAPH_APP_*` 域名匹配 |
| `FOLDERS` | ⬜ | CSV，默认 `inbox,junkemail` |
| `DATABASE_URL` | ✅ | Postgres connection string（Supabase 拷连接串即可；非本地 host 自动开 TLS） |
| `PG_MAX_POOL` | ⬜ | 默认 10 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` | ✅/⬜ | BullMQ 必需 |
| `POLL_*` / `*_CONCURRENCY` | ⬜ | 节奏与并发 |
| `V2_*` | ⬜ | 见 **「§7 V2」** |

启动会在 stdout 打印**脱敏摘要**与 Notion schema 校验结果；如果列名/类型不对，**进程会以 exit code 2 退出**。

> 自定义路径：设置 `DOTENV_PATH=/some/other/.env` 即可。

---

## 4. 运行

```bash
# 1. 安装依赖
npm install

# 2. 生成并应用 Drizzle 迁移
npm run db:generate
npm run db:migrate

# 3. 一终端跑 API + Notion poller
npm run dev

# 4. 另一终端跑 workers（发信 / 收件 / 匹配 / webhook / V2 维护 / token 预热）
npm run dev:worker
```

健康检查：

```bash
curl http://127.0.0.1:3737/health
# -> { ok, dependencies: { postgres, redis, notion, graph }, graph_apps: {...}, tokens: [...] }
# graph_apps 会列出每个域名 App 是否能拿到 token
```

### 4.1 不依赖 PG/Redis 的发信冒烟

只想验证 Azure 应用 + 域名权限是否到位、不想起 PG/Redis 时：

```bash
# 默认用 config.mailboxes[0].email 当发件人；--from 可显式指定
npm run smoke:send -- --to alice@example.com [--from sender@yourdomain.com] [--lookup]
```

脚本只调用 MSAL + Graph，**完全绕开 PG / Redis / BullMQ / Notion**。失败时会打印 `http status` / `graph code` / `details`。

---

## 5. 流程一览

```
Notion DB (OutReach Status=Todo, Action∈{Send,Reply}, Platform=Email, InNOut=Out,
           Trigger Time 为空 或 ≤ 当前时间)
   │
   ▼  notion poller (15s)
BullMQ: send  ─►  Send Worker
                    │
                    ├─► markSending → graph.sendMail → findRecentSentMessage
                    ├─► insert outbound_messages
                    └─► writeSendSuccess (Status / Completion Time / Payload._graph)

Mailbox folders (inbox, junkemail) ─► inbox scheduler (30s)
   │
   ▼
BullMQ: inbox-poll  ─►  Inbox Worker
                          │
                          ├─► insert inbox_messages (idempotent)
                          └─► enqueue match

BullMQ: match  ─►  Match Worker
                    │
                    ├─► detectBounce(from/subject)
                    ├─► matchInboundByConversation(conversationId)
                    └─► writeReply / writeBounce in Notion
```

---

## 6. 写回 Notion 的字段

| 场景 | 写入列 |
| --- | --- |
| 发送中 | `OutReach Status = Sending` |
| 发送成功 | `OutReach Status = Success` + `Completion Time` + `Payload._graph` |
| 发送失败 | `OutReach Status = Failure` + `Result Remark` |
| 收到回复 | `Reply Body` + `Reply Email`（email） + `Last Reply Time`（Asia/Shanghai） |
| 退信 | `OutReach Status = Failure` + `Result Remark = bounce reason` + `Payload._graph_bounce` |

Graph 元数据（`graphMessageId / conversationId / internetMessageId`）**只写入 `Payload` JSON 的 `_graph` 段**，不在 Notion 新增列（与 minimal-server 约定一致）。

---

## 7. V2：Webhook + Delta（可选）

在 `config.json` 中设置 `"v2": { "enabled": true, ... }` 后：

| 配置项 | 说明 |
| --- | --- |
| `public_base_url` | 公网 **HTTPS** 根地址（无尾斜杠），如 `https://hooks.example.com` |
| `webhook_path` | Graph 回调路径，默认 `/webhooks/graph`（完整 URL = `public_base_url` + `webhook_path`） |
| `subscription_client_state_secret` | 写入订阅的 `clientState`；每条通知必须一致，否则丢弃（≥8 字符） |
| `subscription_renew_lead_hours` | 到期前多少小时开始 PATCH 续订（默认 12） |
| `delta_sync_interval_ms` | Delta 补偿轮询周期（默认 5 分钟） |
| `disable_polling_when_v2` | `true` 时不再跑 30s inbox 轮询（仅 Webhook + Delta；订阅全挂时风险更高） |

**运行时行为**

0. **先启动 API 进程**（`npm run dev`），再启动 **worker**（`npm run dev:worker`）：Graph 创建订阅时会立刻 `GET` 回调 URL 校验 `validationToken`，若 API 未监听会导致订阅创建失败。

1. **API 进程**：注册 `GET/POST` Webhook 路由；校验请求必须返回 **200 + `text/plain` 原文**。

2. **Worker 进程**：启动后 `bootstrapV2Once`：为每个 `can_receive` 邮箱 × `folders` 创建/续订订阅，并跑一轮 Delta 初始化 `@odata.deltaLink`；之后每小时续订、按 `delta_sync_interval_ms` 跑 Delta。

3. **Webhook**：`POST` 收到通知后校验 `clientState`，将 `GET /users/.../messages/{id}` 任务丢进 `webhook-ingest` 队列（与轮询/Delta 共用 ingest + match）。

4. **Delta**：按间隔用 PG 中保存的 `delta_link` 拉增量，补偿漏掉的 Webhook。

5. **轮询**：默认仍开启作兜底；若 `disable_polling_when_v2=true` 则仅依赖 Webhook + Delta。

**Azure 注意**

- 回调 URL 必须公网可达（本地开发可用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) / ngrok 等）。
- Application 权限只需 `Mail.Send` + `Mail.ReadWrite`（或 `Mail.Read`）并 admin consent；Graph 的 webhook 订阅与 Delta query 都包含在这些权限里，**无需** 单独的 `Subscription.*` 权限。

参考：[Change notifications](https://learn.microsoft.com/graph/change-notifications-delivery-webhooks) · [Delta query messages](https://learn.microsoft.com/graph/delta-query-messages)

---

## 8. 后续可增强（非 V2 范围）

- 附件超过 3 MB（`createUploadSession`）
- 跨 tenant 回复的 `In-Reply-To` / `References` 兜底匹配
- 自建文件夹遍历（当前仅配置中的 well-known，如 `inbox` / `junkemail`）

---

## 9. 项目结构

```
src/
  auth/        # MSAL App-only + token warmer
  config/      # Zod-validated config loader + masked banner
  db/          # Drizzle schema + repos + migrate
  graph/       # Graph REST client + mail + subscription + delta + webhook parse
  notion/      # client / property-mapper / writer / poller / schema-validator
  queues/      # BullMQ queues + Redis connection
  routes/      # Fastify routes (health + graph webhook V2)
  services/    # job-builder / message-store / reply-matcher / bounce-detector / inbox-ingest
  utils/       # logger, sleep
  workers/     # send / inbox / match / webhook-ingest / v2-maintenance
  server.ts    # API + Notion poller process
  worker.ts    # workers process
```
