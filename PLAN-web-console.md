# Web 控制台与配置入库 — 实施计划

**Overall Progress:** `95%`

> 依据探索阶段已确认结论整理；范围不超出已对齐需求。

## TLDR

在现有 **Fastify + Drizzle PG + Microsoft Graph + Notion** 上：

- 将 **Graph 多域应用配置**（原 `GRAPH_APP_*`）迁入 **PostgreSQL**，支持 **热更新**（MSAL client / token 按 appKey 失效）。
- 在 **`inbox_messages` / `outbound_messages`** 持久化 **KeyPerson**、**Entity**（含显示名与 Notion URL）。
- 新增 **单密码（`.env`）** 的 **Web 控制台**：左侧菜单 + 右侧主区 — **Dashboard**、**Inbox**、**Outbound**、**Domain Config**、**Email Config**。
- **Inbox**：筛选、分页、按需 Graph 拉 **完整 HTML** 与 **附件**（下载走服务端代理）；**Reply** 基于对方邮件 **`createReply` 同线程续回**；数据以 **PG 为主**；有 Notion 能力时 **新建 Page**，**Outreach Status = Success（非 Todo）**，发信成功后 **`writeSendSuccess`**，与现网 **Reply Email** 语义一致；**无锚点则不回写 Notion**，**`outbound_messages.notion_page_id` 可空**。
- **Outbound**：筛选与列表，无 Reply、无下钻。
- **Entity / KeyPerson 下钻**：弹窗合并展示 inbox + outbound，按收/发时间倒序。
- **Dashboard**：可基于现有表聚合的指标 + **明确标注** v1 无法统计的指标及下一版补数思路。

## Critical Decisions

| 决策 | 说明 |
|------|------|
| Graph 配置来源 | 运行时以 **DB** 为权威；热更新时 **丢弃**对应 `appKey` 的 MSAL client 与 token，必要时 `force` 刷新。 |
| Notion 与防双发 | Web 触发的记录用 **新 Notion Page**；**Outreach Status = Success**；**Action = `NOTION_ACTION_REPLY`**，`Payload` 含 **`replyToGraphMessageId`** 等，与 `buildSendJobFromNotion` / `writeSendSuccess` 对齐，**避免 poller 当 Todo 重复发**。 |
| 无 Notion 路径 | 允许回复；**不创建 Page**；**`notion_page_id` nullable**。 |
| 正文与附件 | 轮询入库仍为 preview；**详情 / Reply 弹窗** 按需 **Graph GET message**；附件 **后端代理** `$value`，受登录态保护。 |
| 鉴权 | **`.env` 单密码** + **HttpOnly Session Cookie** + HTTPS + 限流（产品形态仍为「一个密码」）。 |
| 前端 | **独立前端工程**（建议 Vite + React）；表格/筛选/布局/弹窗用 **成熟组件库**；Fastify **静态托管 `web/dist` + `/api`**。 |

## Tasks

- [x] 🟩 **Step 1: 数据模型与迁移**
  - [x] 🟩 新增 **`graph_apps`（或等价）表**：`domain`（app key）、`tenant_id`、`client_id`、`client_secret`、`enabled`、`updated_at` 等；同步 `scripts/full-schema.sql`、Drizzle schema、migrate。
  - [x] 🟩 **`inbox_messages` / `outbound_messages`**：增加 KeyPerson / Entity 的 id、名称、Notion URL 等列；按筛选需求加索引。
  - [x] 🟩 **`outbound_messages.notion_page_id`**：**改为可空**；迁移策略不破坏现有行。
  - [x] 🟩 **写入路径**：match / ingest / send 等已有写 PG 逻辑处写入或回填 KeyPerson/Entity（以 Notion 可得数据为准）。

- [x] 🟩 **Step 2: 配置加载与热更新**
  - [x] 🟩 DB 读取 graph_apps，等价替代 env 拼出的 `graph_apps` 映射；启动 + 版本戳/定时刷新。
  - [x] 🟩 配置变更时 **移除**对应 appKey 的 MSAL client 与 token cache。
  - [x] 🟩 **`/health`** 中 Graph 探测改为基于 DB 中的 apps（`getEffectiveGraphAppsSync`）。

- [x] 🟩 **Step 3: Notion — Web Reply 记录页**
  - [x] 🟩 封装 **创建「Reply Email」结果行**：`Action = NOTION_ACTION_REPLY`，`Payload.replyToGraphMessageId` 等满足 `buildSendJobFromNotion`；**Outreach Status = Success**。
  - [x] 🟩 发信成功后对 **新 pageId** 调用 **`writeSendSuccess`**；无 Notion 路径跳过。

- [x] 🟩 **Step 4: Graph 按需详情与附件 API**
  - [x] 🟩 Service：`GET /users/{mailbox}/messages/{id}`，含 body、附件元数据；`actorMailbox` 来自 inbox 所属 mailbox。
  - [x] 🟩 附件下载：登录后可访问的代理路由；大小上限与错误处理。

- [x] 🟩 **Step 5: Web Reply 发信 API**
  - [x] 🟩 入参：`inbox_message_id`、body（HTML）、可选 subject；校验权限与数据。
  - [x] 🟩 **`sendMailReplyInThread`** → **`recordOutbound`**（`notion_page_id` 有则新 page id，无则 null）。
  - [x] 🟩 有 Notion：**创建 Page（Success）→ 发信 → `writeSendSuccess`**；失败顺序与补偿在代码注释中写明。

- [x] 🟩 **Step 6: 管理 API — Inbox / Outbound 列表**
  - [x] 🟩 Inbox：筛选（Entity、KeyPerson、email、domain、回复日期区间）、分页、默认 **`received_at` DESC**；FCAccount = `mailboxes.email` join。
  - [x] 🟩 Outbound：筛选 + 分页 + 排序；无 Reply、无下钻。
  - [x] 🟩 **下钻 API**：按 Entity 或 KeyPerson 过滤 inbox + outbound，合并按收/发时间倒序。

- [x] 🟩 **Step 7: 管理 API — Domain / Email 配置**
  - [x] 🟩 Domain：`graph_apps` CRUD（secret 更新策略）。
  - [x] 🟩 Email：`mailboxes`（及文档约定的邮箱表）CRUD；与 `auditMailboxesAgainstApps` 兼容。

- [x] 🟩 **Step 8: 鉴权**
  - [x] 🟩 `.env`：`ADMIN_UI_PASSWORD`（或约定变量名）；`POST /api/auth/login`、`logout`；`/api/*` 除 login 外需 session。
  - [x] 🟩 Cookie 安全属性 + 登录限流。

- [x] 🟩 **Step 9: Dashboard API + v1 指标边界**
  - [x] 🟩 聚合：昨日发送量、发送成功率、今日待发送、近 30 天可从 PG 推导的比率（口径与 `thread_status` / 时间字段一致）。
  - [x] 🟩 响应或 UI 脚注：**打开率、细粒度正向回复率** 等 v1 不承诺及下一版方案（追踪像素 / `message_events` 等）— 仅说明，不实现追踪。

- [x] 🟩 **Step 10: 前端应用**
  - [x] 🟩 脚手架 + 五菜单路由 + 左右布局。
  - [x] 🟩 登录页；API 请求携带 cookie。
  - [x] 🟩 Inbox：筛选、表格、分页；Reply 弹窗（**iframe 渲染对方 HTML**、**附件下载链接**）；Entity/KeyPerson **下钻时间线弹窗**。
  - [x] 🟩 Entity / KeyPerson 列 → 时间线弹窗（`/api/timeline` + Inbox 表格可点击下钻）。
  - [x] 🟩 Outbound、Domain Config、Email Config 页面。
  - [x] 🟩 构建产物由 Fastify 静态目录或反向代理提供。

- [ ] 🟨 **Step 11: 配置样例与验收**
  - [x] 🟩 `.env.example`：管理密码；`GRAPH_APP_*` 标注废弃或迁移说明。
  - [ ] 🟨 验收：热更新、无 Notion 回复、有 Notion 新页 Success、附件下载、poller 不误拾取 Web 行（需在真实环境手测）。

## 进度图例

- 🟩 Done  
- 🟨 In Progress  
- 🟥 To Do  

完成子任务后将对应 🟥 改为 🟨 / 🟩，并更新文首 **Overall Progress** 百分比。
