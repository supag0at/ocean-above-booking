# A-01 前后端架构设计（v0.6，设计阶段终版）

- 日期：2026-11-18
- 作者：A-01 设计会话（T1）
- 状态：⏳ 草案。契约终稿由父会话合并为"契约 v1"。
  - v0.4 是按正交验收报告 [A-01-review.md](../reviews/A-01-review.md) 返工的版本：修复了全部阻塞项（B-1..B-3）和重要项（I-1..I-14），逐条回应了建议项（S-1..S-17）、接缝矛盾（C-1..C-18）和简化建议（O-1..O-8）。完整对照见 **§18**。
  - v0.5 按契约变更广播落实了 D-52..D-63 和父会话对 C-7 的裁定，并和 [A-02 v0.4](A-02-agent.md) 对齐，变更记录见 **§18.5**。
  - 已落实的决策：D-21..D-63 里和 A-01 有关的全部决策（含 D-28、D-51、D-52、D-54、D-55、D-59、D-60、D-63），以及 R-U1，见 §14.1。
  - **v0.6 是设计阶段的最后一版**：落实 D-63 的再次修订和 D-64 的结论（ReAct 中间过程要短暂显示，见 §9.4.1）。人已决定设计不再复核（R-U2），之后由父会话直接合并成契约 v1。变更记录见 **§18.6**。
  - 本文没有遗留的待决策（D-64 已决）。
  - 版本变化：v0.1 → v0.2 对齐 A-02；v0.2 → v0.3 落实人的决策；v0.3 → v0.4 修复验收问题；v0.4 → v0.5 落实 D-52..D-63。
- 依据：[P-01](../planning/P-01-project-layer.md) v1.0、[A-03](../planning/A-03-dag-and-session-roles.md)、[decisions.md](../adr/decisions.md)、[R-01](../research/R-01-pi-and-managed-agents.md)（含 §4 数据陷阱）、[W1-seams.md](../tasks/W1-seams.md)、[A-02](A-02-agent.md) v0.4
- 范围：W1-seams 归属表里归 A-01 的行（对照表见 §15）。agent 内部的内容（harness 循环、工具 schema、上下文、记忆写入规则）归 A-02，本文只引用。

---

## 0. 一页总览

```
                   Internet / 局域网
                          │ :80 / :443（虚拟机上唯一对外开放的端口）
  network: edge   ┌───────▼────────┐  （edge 可以出网：拿到域名后 Caddy 要申请证书）
                  │ caddy          │  静态 SPA（apps/web 构建产物）
  network: front  │ 172.30.1.10    │  /api/* → 172.30.1.20:8080（SSE 不缓冲）
  (internal)      └───────┬────────┘
                          │
  ┌───────────────────────▼─────────────────────────────────────────────────────┐
  │ gateway  :8080 公共 API  —— 只绑定在 front 网卡 172.30.1.20，只接受来自 caddy 的连接 │
  │          :8081 session API —— 只绑定在 app 网卡 172.30.2.20，服务 token + fence    │
  │  拥有：users / sessions / events（只追加）/ memory_deletions                       │
  │  后台：sweeper（每 15s：未消费输入的门铃恢复 + 出票事件对账）                      │
  └──┬──────────────┬─────────────────────┬───────────────────┬──────────────────┘
     │ app          │ app                  │ bk                │ db_main
  ┌──▼─────┐  ┌─────▼──────────┐    ┌──────▼──────┐     ┌─────▼──────┐
  │ redis  │◄─┤ harness        │    │ booking     │     │ postgres   │
  │ 门铃    │  │ 没有数据库凭证   │    │ :8083 只绑定 │     │ pg_hba 按  │
  │ 租约    │  │ 没有订单凭证     │    │ bk 网卡      │◄────┤ 角色限制来源│
  │ pubsub │  │ 只有 LLM key    │    │ 唯一能写     │     │ 子网       │
  └────────┘  └─────┬──────────┘    │ tickets     │     └─────▲──────┘
                    │ app            └─────────────┘           │ db_main
              ┌─────▼──────────┐                               │
              │ hands :8082    ├───────────────────────────────┘
              │ execute(name,  │  locations.db 只读挂载，启动时校验哈希
              │   input)       │  写 quotes / quote_offers / tool_calls / user_memories
              └────────────────┘
  harness 另外接入 egress 网络（访问 DeepSeek）。其余内部网络全部 internal: true（不能出网）。
  机密一律以文件形式挂载到 /run/secrets/*，不进环境变量（D-28）。
```

两个核心不变量（落到架构上）：
1. **数字从库里来，到卡片上去**：报价由 hands 根据 `locations.db` 算出来并落库；前端的报价卡**只读 `GET /api/v1/quotes/:quoteId`**，不读 LLM 的文本，也不读事件里的数字。`quote.offered` 只带 `{ runId, quoteId, toolCallId }`。
2. **LLM 没有任何下单途径**：唯一的下单入口是浏览器发出的 `POST /api/v1/quotes/:quoteId/confirm`（cookie + CSRF + Origin）→ gateway → booking。harness 没有下单工具（A-02 §13.1），没有 booking 的凭证和数据库凭证，网络上连不到 booking，也连不到 gateway 的公共端口（§2.2）。
   - **这条不变量说的是"agent / LLM 不能下单"，不是"一个被攻破的 harness 进程什么都做不了"**。被攻破的进程能做什么、不能做什么，见 §2.7 和 §12。

会话层的契约不变量（B-3，父会话裁定）：
> **任何已经落库、但还没被任何运行消费的 `user.message`，必须在有限时间内被处理。**
- gateway 侧的保证：§6.4 的消费跟踪，加上 §7.4 的 sweeper。判断依据是"有没有未消费的输入"，**不看 status**；status 只用来显示。

---

## 1. 模块和目录切分（monorepo，D-15）

### 1.1 目录
```
flight-booking/
├── apps/
│   └── web/                    React + Vite SPA（T11，前端会话）
├── services/
│   ├── gateway/                公共 API + session API + sweeper（T06）
│   ├── booking/                确认下单（T07）
│   ├── hands/                  execute(name, input) + 领域工具（T08）
│   └── harness/                BullMQ worker + pi 适配层（T09，内部设计见 A-02）
├── packages/
│   ├── contracts/              类型、schema、事件、错误码、常量（T01，只有父会话能改）
│   ├── flight-core/            纯领域逻辑：加载 db、建图、路线、城市解析（T03）
│   ├── memory/                 长期记忆的领域逻辑（T10，规则见 A-02）
│   └── platform/               分成多个子入口（§1.2）：log、trace、config、secrets、http、fastify、pg、redis
├── eval/                       独立参考实现（oracle）、评测用例和报告（T04/T13）
├── e2e/                        Playwright 端到端测试（T15）
├── infra/
│   ├── compose/                compose.yml、compose.dev.yml、各服务 Dockerfile
│   ├── caddy/                  Caddyfile、Caddy 镜像的 Dockerfile（把 SPA 构建产物拷进去）
│   ├── db/                     migrations/（只有 SQL）、init/00-roles.sh（第一次初始化时建角色，T05）
│   ├── redis/                  entrypoint.sh（从 secret 文件生成 aclfile）
│   ├── secrets/                *.example（真实的 secret 文件被 gitignore，§2.3）
│   └── vm/                     虚拟机初始化脚本（T14）
├── scripts/                    check、hash 校验、密钥扫描、manifest 检查
├── spikes/                     可以丢弃的验证代码（S-01）
├── docs/
├── locations.db                只读，sha256 = fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f
└── prompt history/
```

### 1.2 依赖规则（由 dependency-cruiser 在 `pnpm check` 里强制，T00 实现）
`packages/platform` 拆成子入口（S-10），按子入口授予依赖权限，这样"harness 没有 pg 驱动"才是真的：

| 子入口 | 内容 | 依赖的第三方库 |
|---|---|---|
| `@fb/platform/log` | pino 工厂和 redact 配置 | pino |
| `@fb/platform/trace` | `Tracer` / `Span` 接口和空实现 | OTel API |
| `@fb/platform/config` | 非机密配置的加载和校验（TypeBox） | — |
| `@fb/platform/secrets` | `SecretProvider`（§2.4） | — |
| `@fb/platform/http` | 服务间 HTTP 客户端（自动加 trace 头） | undici |
| `@fb/platform/fastify` | Fastify 工厂函数：ajv 配置、绑定地址、来源地址检查、错误信封 | fastify |
| `@fb/platform/pg` | pg 连接池工厂 | pg |
| `@fb/platform/redis` | ioredis 工厂 | ioredis |

| 模块 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `packages/contracts` | `web` 入口：只能用 TypeBox；`server` 入口：TypeBox、`node:crypto`（S-11） | 任何 workspace 包、任何网络或文件 IO |
| `packages/flight-core` | contracts、`node:sqlite`、`node:crypto` | platform、任何服务、网络 |
| `packages/memory` | contracts | 任何服务、pg 驱动（存储由 hands 注入） |
| `services/gateway` | contracts、platform 的全部子入口、bullmq | flight-core、memory、其他服务 |
| `services/booking` | contracts、platform（除 `redis`） | flight-core、memory、bullmq、ioredis、其他服务 |
| `services/hands` | contracts、platform（除 `redis`）、flight-core、memory | bullmq、ioredis、其他服务、pi 的包 |
| `services/harness` | contracts、platform（除 `pg`）、bullmq、`@earendil-works/pi-*` | **`@fb/platform/pg` 和 pg**、flight-core、memory、其他服务 |
| `apps/web` | **只能用 `@fb/contracts/web`**（§1.3）、前端库 | contracts 的其他入口、任何服务、platform、flight-core、memory |
| `eval/oracle` | **什么都不依赖**（独立实现，可以用 Python） | flight-core（T04 必须隔离） |

另外：
- 任何包都不能引入 `child_process`、`vm`、`eval`（lint 规则）。
- 只有 `services/booking` 的代码里能出现对 `tickets` 的 INSERT 语句（`scripts/check` 用 grep 检查，数据库授权再兜底）。
- ID 生成放在 `@fb/contracts/server`：前缀加 26 位随机 Crockford base32，用 `crypto.randomBytes` 生成（O-7，不需要按时间排序，所以不用 ULID）。格式见 §3.2。
- `canonicalJson()`（递归排序键、不带空白）放在 `@fb/contracts/server`，用于所有"对 JSON 取哈希"的地方（I-5）。

### 1.3 前后端分离（R-U1：前端和后端必须由不同的会话来写）
**目录归属**（T00 的路径白名单 hook 按这张表强制检查；同一个任务的 manifest 里不能同时出现"前端会话"和"后端会话"两行的路径）：
| 归属 | 目录 |
|---|---|
| **前端会话** | `apps/web/**`（包括它的 i18n 文案、MSW mock、组件测试） |
| **后端会话** | `services/**`、`packages/flight-core/**`、`packages/memory/**`、`packages/platform/**`、`infra/db/**`、`infra/redis/**` |
| **父会话**（契约，两边共享） | `packages/contracts/**`、`docs/contracts/**` |
| 其他独立任务 | `eval/**`（T04 / T13）、`e2e/**`（T15）、`infra/compose/**`、`infra/caddy/**`、`infra/secrets/**`、`infra/vm/**`（T14） |

**两边共享的东西只能放在 contracts 里**，而且 contracts 拆成两个入口，防止服务端代码被打包进浏览器：
| 入口 | 内容 | 谁能用 |
|---|---|---|
| `@fb/contracts/web` | 公共 API 的请求和响应类型（§4.5）、**公共事件视图 `PublicEvent`**（§4.5，不是内部的 `EventEnvelope`，I-4）、临时事件类型、TypeBox schema（用于生成 mock 数据和前端自测）、`ErrorCode` 枚举、i18n 用到的常量 key（工具名、错误码） | 前端和后端都能用 |
| `@fb/contracts/server` | 内部的 `EventEnvelope` 和各事件的完整 payload、内部 API 的类型（session API、booking、hands 信封）、事件写入白名单、ID 生成、`canonicalJson`、`user.message` 转义函数、数字格式化函数、`locations.db` 的哈希常量 | **只有后端能用**（前端 import 时 dependency-cruiser 报错） |

规则：
- `@fb/contracts/web` 不能 import `@fb/contracts/server`，也不能依赖任何 Node 内置模块（`node:*`）。由 T01 的契约测试检查。
- 只在前端使用的类型（组件 props、视图状态）留在 `apps/web` 里，**不放进 contracts**。只在后端使用的类型留在各自的服务里。
- 文案只在前端：错误码、工具名对应的中英文文案都放在 `apps/web/src/i18n/`；后端只返回错误码和英文的调试 message（§4.1）。
- 前端开发时，所有后端接口都用 MSW mock（§9.7），mock 的数据从 `@fb/contracts/web` 的 schema 生成并校验。所以前端会话完全不需要碰后端代码。
- 唯一跨两边的构建步骤是 Caddy 镜像把 `apps/web` 的构建产物拷进去（D-27）。这一步的 Dockerfile 放在 `infra/caddy/`，归 T14。

---

## 2. 运行拓扑（容器、网络、端口、机密）

### 2.1 容器清单
v1 **每个服务部署 1 个副本**（O-4）。所有服务都是无状态的，可以横向扩展：唯一要注意的是 sweeper 在多副本时要先抢一把 Redis 锁（§7.4）。

| 容器 | 镜像 | 运行身份 | 监听（只绑定在列出的地址上） | 对外端口 |
|---|---|---|---|---|
| `caddy` | caddy:2 + SPA 构建产物（多阶段构建，D-27） | caddy 镜像默认 | 0.0.0.0:80 / 443 | **80、443** |
| `gateway` | node:24-bookworm-slim（D-21） | uid 1000 | 172.30.1.20:8080（公共）；172.30.2.20:8081（session API） | 无 |
| `harness` | node:24-bookworm-slim | uid 1000 | 只做健康检查：127.0.0.1:8084 | 无 |
| `hands` | node:24-bookworm-slim | uid 1000 | 172.30.2.30:8082 | 无 |
| `booking` | node:24-bookworm-slim | uid 1000 | 172.30.3.30:8083 | 无 |
| `postgres` | postgres:16 | 999 | 0.0.0.0:5432（来源由 pg_hba 限制，§2.2） | 无 |
| `redis` | redis:7（AOF everysec，启用 ACL） | 999 | 172.30.2.40:6379 | 无 |
| `migrate` | 和 gateway 同一个镜像，入口不同；一次性运行后退出 | uid 1000 | — | 无 |

### 2.2 网络分段、固定地址和端口绑定（I-1、I-2）
**选择**：父会话给了两条路，"做出能落地的实现"或者"老实降低说法"。A-01 两条都做：
1. 用**固定子网 + 按网卡绑定监听地址 + 来源地址检查**，把"harness 和 hands 连不到 gateway 的公共端口"变成网络层的事实。成本是 compose 里多写几行 IPAM 配置，代码只在 platform 的 Fastify 工厂里集中实现一次。
2. 同时如实写出剩下的口子：harness 能出网，所以它可以像任何一个互联网用户一样，通过虚拟机的公网地址访问 Caddy（§2.7）。

**理由**：拆成两个 gateway 容器（验收报告给的另一个方案）效果相同，但要多一个进程和一份部署配置；按网卡绑定，只需要改一个容器的配置就能达到同样的隔离。

**网络表**：
| 网络 | 子网 | internal | 成员和固定地址 |
|---|---|---|---|
| `edge` | 172.30.0.0/24 | **否**（Caddy 申请证书要出网） | caddy |
| `front` | 172.30.1.0/24 | 是 | caddy `.10`、gateway `.20` |
| `app` | 172.30.2.0/24 | 是 | gateway `.20`、hands `.30`、redis `.40`、harness（动态分配，`.100` 以上） |
| `bk` | 172.30.3.0/24 | 是 | gateway `.20`、booking `.30` |
| `db_main` | 172.30.4.0/24 | 是 | postgres `.10`、gateway `.20`、hands `.30`、migrate `.40` |
| `db_booking` | 172.30.5.0/24 | 是 | postgres `.10`、booking `.30` |
| `egress` | 172.30.6.0/24 | **否** | harness |

和 v0.3 的区别：
- **gateway 不再接入任何可以出网的网络**（I-1）：v0.3 里 `edge` 网络同时有 caddy 和 gateway，而 edge 是可以出网的。现在 edge 只有 caddy，caddy 和 gateway 之间走 internal 的 `front` 网络。
- hands 和 booking 仍然**不共用任何网络**（postgres 同时接入 `db_main` 和 `db_booking`）。

**compose 写法**（T14 照此实现；下面是关键片段）：
```yaml
networks:
  edge:       { ipam: { config: [ { subnet: 172.30.0.0/24 } ] } }
  front:      { internal: true, ipam: { config: [ { subnet: 172.30.1.0/24 } ] } }
  app:        { internal: true, ipam: { config: [ { subnet: 172.30.2.0/24, ip_range: 172.30.2.128/25 } ] } }
  bk:         { internal: true, ipam: { config: [ { subnet: 172.30.3.0/24 } ] } }
  db_main:    { internal: true, ipam: { config: [ { subnet: 172.30.4.0/24 } ] } }
  db_booking: { internal: true, ipam: { config: [ { subnet: 172.30.5.0/24 } ] } }
  egress:     { ipam: { config: [ { subnet: 172.30.6.0/24 } ] } }
services:
  gateway:
    networks:
      front:   { ipv4_address: 172.30.1.20 }
      app:     { ipv4_address: 172.30.2.20 }
      bk:      { ipv4_address: 172.30.3.20 }
      db_main: { ipv4_address: 172.30.4.20 }
    environment:   # 只有非机密配置
      PUBLIC_BIND: 172.30.1.20:8080
      PUBLIC_ALLOWED_PEERS: 172.30.1.10/32          # 只有 caddy
      INTERNAL_BIND: 172.30.2.20:8081
      INTERNAL_ALLOWED_PEERS: 172.30.2.128/25       # harness 的动态地址段（ip_range）
```
- `app` 网络用 `ip_range` 把动态分配的地址限制在 `.128/25`，固定地址（gateway `.20`、hands `.30`、redis `.40`）都在这个范围以外。所以"来自 `.128/25` 的连接"就等于"来自 harness"。

**Fastify 侧**（`@fb/platform/fastify` 的工厂函数，T00 / T06 实现）：
```ts
// 每个监听端口是一个独立的 Fastify 实例，只注册属于它的路由
const app = createServer({ bind: cfg.PUBLIC_BIND, allowedPeers: cfg.PUBLIC_ALLOWED_PEERS, routes: publicRoutes })
// createServer 内部：
//   await app.listen({ host, port })   // host 是固定的网卡地址，不是 0.0.0.0；这个地址不存在时 listen 失败，进程退出（fail closed）
//   app.addHook('onRequest', (req, reply, done) => {
//     if (!cidrContains(allowedPeers, req.socket.remoteAddress)) return reply.code(403).send(err('FORBIDDEN_PEER'))
//     done() })
//   trustProxy 只信任 PUBLIC_ALLOWED_PEERS（用于从 X-Forwarded-For 取真实客户端 IP 写日志），
//   来源地址检查一律看 socket.remoteAddress，不看任何转发头
```
- hands（`172.30.2.30:8082`，只允许 `.128/25`）和 booking（`172.30.3.30:8083`，只允许 `172.30.3.20/32`）用同一个工厂函数。

**pg_hba**（T05 的 `infra/db/init/`）：按角色限制来源子网。即使某个服务拿到了别的角色的密码，也只能从自己所在的网络登录：
```
# 内部网络，不用 TLS；按角色限制来源地址（数据库名是 app）
host  app  fb_gateway  172.30.4.20/32  scram-sha-256
host  app  fb_hands    172.30.4.30/32  scram-sha-256
host  app  fb_owner    172.30.4.40/32  scram-sha-256
host  app  fb_booking  172.30.5.30/32  scram-sha-256
host  all  all         0.0.0.0/0       reject
```

**可达性矩阵**（✅ 能连；❌ 在网络层就连不到，或者在 TCP 建立后被来源地址检查拒绝。T14 / T15 的网络测试逐格验证）：
| 从 \ 到 | gateway:8080 | gateway:8081 | hands:8082 | booking:8083 | postgres | redis | 公网 |
|---|---|---|---|---|---|---|---|
| caddy | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| gateway | — | — | ✅（用不到） | ✅ | ✅（fb_gateway） | ✅ | **❌** |
| harness | **❌**（没绑定在 app 网卡上） | ✅ | ✅ | **❌** | **❌** | ✅ | ✅（为了访问 LLM，见 §2.7） |
| hands | **❌** | ❌（来源地址检查） | — | **❌** | ✅（fb_hands） | ❌（没有 ACL 账号） | ❌ |
| booking | ❌ | ❌ | ❌ | — | ✅（fb_booking） | ❌ | ❌ |
| migrate | ❌ | ❌ | ❌ | ❌ | ✅（fb_owner） | ❌ | ❌ |

### 2.3 机密分发（D-28 ✅：Compose 的 file-based secrets，不放进环境变量）
机密一律以文件形式挂载到容器内的 `/run/secrets/<name>`。**环境变量里只放非机密配置**。原因：环境变量用 `docker inspect` 就能看到，会被子进程继承，也容易在错误日志里被整体打印出来。

**机密 × 容器矩阵**（✅ = 挂载；空白 = 不挂载。H-07 的检查就是逐个容器核对这张表，I-13 要求列全 8 个容器）：
| secret 文件 | caddy | gateway | harness | hands | booking | postgres | redis | migrate |
|---|---|---|---|---|---|---|---|---|
| `pg_superuser_password` | | | | | | ✅ | | |
| `pg_owner_password` | | | | | | ✅（初始化） | | ✅ |
| `pg_gateway_password` | | ✅ | | | | ✅（初始化） | | |
| `pg_hands_password` | | | | ✅ | | ✅（初始化） | | |
| `pg_booking_password` | | | | | ✅ | ✅（初始化） | | |
| `redis_gateway_password` | | ✅ | | | | | ✅ | |
| `redis_harness_password` | | | ✅ | | | | ✅ | |
| `deepseek_api_key` | | | ✅ | | | | | |
| `harness_service_token` | | ✅（校验） | ✅（持有） | | | | | |
| `booking_service_token` | | ✅（持有） | | | ✅（校验） | | | |
| `hands_token_signing_key`（Ed25519 私钥） | | ✅ | | | | | | |
| `cookie_secret` | | ✅ | | | | | | |

不算机密、以只读配置文件挂载的（`configs`，或者直接 bind mount 成 `:ro`）：
- `hands_token_public_key.pem`：挂进 gateway 和 hands；
- `locations.db`：**只**以 `:ro` 方式挂进 hands。

不在矩阵里的：
- **`LOCATIONS_DB_SHA256` 不是配置**（S-12）：它是 `@fb/contracts/server` 里的常量，**不接受环境变量覆盖**。
- caddy 不持有任何机密。拿到域名后，Caddy 申请到的证书私钥保存在它自己的数据卷里。

**各方怎么用这些文件**：
- **postgres**：超级用户密码用官方镜像支持的 `POSTGRES_PASSWORD_FILE`。`infra/db/init/00-roles.sh` 只在**第一次初始化**时运行，从 `/run/secrets/pg_*_password` 读取各个角色的密码并 `CREATE ROLE … PASSWORD`。所以 migrate **只**持有 `fb_owner` 的密码，不持有其他角色的密码（I-13）。轮换角色密码时，由运维用超级用户手动执行 `ALTER ROLE`，再重启对应的服务。
- **redis**：`infra/redis/entrypoint.sh` 启动时从两个 secret 文件生成 aclfile（写到 tmpfs，密码以 `#<sha256>` 的形式保存），然后 `redis-server --aclfile`。
- **各个 Node 服务**：数据库连接由普通配置（`PG_HOST`、`PG_DATABASE`、`PG_USER`）加上 `SecretProvider` 读出的密码拼成；**不存在**整串的 `DATABASE_URL` 环境变量。

**单机 Compose（非 Swarm）的限制**（B-1 里引用的 §14.2 意见；**T14 用实际的 Compose 版本验证**）：
- 非 Swarm 模式下，file-based secret 本质上是**宿主机文件的只读 bind mount**：不加密，也不经过 Raft。长语法里的 `uid` / `gid` / `mode` 很可能不生效，容器里文件的属主和权限等于宿主机文件的属主和权限。
- 所以宿主机上这样处理：`/opt/ocean-above/infra/secrets/` 目录权限 `0700`，属主 root，这样宿主机上的其他用户读不到；里面的文件权限 `0444`，因为同一个文件要被不同 uid 的容器读取（gateway 是 1000，postgres 和 redis 是 999）。容器内部能读这个文件的进程，和这个服务本身属于同一个信任域，这是可以接受的。
- 轮换：更新文件以后要重启对应的服务，单机 Compose 没有热更新。v1 接受这一点。
- 仓库里只放 `infra/secrets/*.example`；真实文件被 gitignore，并且由 `scripts/check` 和 pre-commit 的密钥扫描兜底。

**根目录 `.env`**（用户写的 `DEEPSEEK_API_KEY`）只用于本地开发和 S-01。部署时由 `infra/vm/` 的脚本把它写进 `infra/secrets/deepseek_api_key`，然后从部署目录里删掉 `.env`。**compose 文件里不写 `${...}` 形式的机密插值**，避免 compose 自动读取 `.env` 后，把机密注入到容器的环境变量里。

### 2.4 `SecretProvider`（`@fb/platform/secrets`）
```ts
type SecretName = 'pg_password' | 'redis_password' | 'deepseek_api_key' | 'harness_service_token'
                | 'booking_service_token' | 'hands_token_signing_key' | 'cookie_secret'
interface SecretProvider { get(name: SecretName): string }   // 启动时一次性读取并缓存；缺少文件时启动失败
```
- **`FileSecretProvider`**（生产环境）：读取 `/run/secrets/<文件名>`，去掉结尾的换行符。服务内部的名字（比如 `pg_password`）到文件名（比如 `pg_hands_password`）的映射，写在每个服务自己的配置里。
- **`EnvSecretProvider`**（只用于本地开发）：从环境变量读取，方便在 Windows 上直接运行 `pnpm dev`。**只有在 `NODE_ENV=development` 并且 `ALLOW_ENV_SECRETS=1` 时才允许使用**，否则构造时直接抛错。生产镜像固定设置 `NODE_ENV=production`。
- 以后换成 OpenBao 或 Vault 时，只需要新增一个实现，业务代码不用改（§17）。
- 测试：① 生产配置下构造 `EnvSecretProvider` 必须抛错；② 缺少 secret 文件时服务必须启动失败；③ 日志的 redact 配置会屏蔽 `SecretProvider` 返回的任何值。

### 2.5 进程间通信总表
| 调用方 → 被调方 | 方式 | 鉴权 | 超时 | 用途 |
|---|---|---|---|---|
| 浏览器 → caddy → gateway:8080 | HTTPS REST + SSE | cookie `fb_sid` + `X-CSRF-Token` + Origin（§4.2）；来源地址只允许 caddy | REST 10s；SSE 长连接 | §4 |
| gateway → redis | BullMQ `harness-wake`（生产者）；`lease:fence:*` 的读、校验和重置；pubsub；`auth:*` | ACL `gateway` | 2s | 按门铃、fence、SSE 扇出、登录会话 |
| harness → redis | BullMQ worker；`lease:*`；PUBLISH 临时事件 | ACL `harness` | 2s | §7 |
| harness → gateway:8081 | HTTP JSON | `Authorization: Bearer <harness_service_token>`；写操作再加 `X-Lease-Fence` | 5s | getEvents / emitEvent / hands token（§5.1） |
| harness → hands:8082 | HTTP JSON `POST /internal/execute` | `Authorization: Bearer <hands token>` | 工具级别，A-02 定 | 信封由 A-02 §5 定 |
| gateway → booking:8083 | HTTP JSON | `Authorization: Bearer <booking_service_token>`；来源地址只允许 gateway | 5s | §5.2 |
| gateway / hands / booking / migrate → postgres | pg 连接池 | 各自的角色 + pg_hba 来源限制 | 语句超时 5s | §3 |
| harness → DeepSeek | HTTPS（pi-ai） | `deepseek_api_key` | A-02 定 | LLM |

所有内部 HTTP 调用都带 `traceparent` 和 `X-Trace-Id`（§8，X-9）。

### 2.6 harness 出网的扩展点（D-26：暂时不加白名单，只预留扩展点）
- harness 读取配置项 `EGRESS_PROXY_URL`（不是机密）。**为空时直连**，这是 v1 的默认值。
- 不为空时，harness 访问 LLM 的所有 HTTP 请求都经过这个代理。这样以后要加白名单，只需要部署一个出网代理（比如 smokescreen 或 squid，只放行 DeepSeek 的域名），并且把 harness 从 `egress` 网络移到只能访问这个代理的网络上，**不需要改 harness 的代码**。
- 实现方式（T09 验证，以下都**没有验证**）：Node 24 内置的 `fetch` 默认不读取 `HTTPS_PROXY`。可以在启动时用 undici 的 `ProxyAgent` 设置全局 dispatcher，或者，如果 pi-ai 支持传入自定义的 fetch 或 dispatcher，就从那里注入。不管哪种方式，都收在 pi 适配层（A-02 §6）的一个函数里。

### 2.7 被攻破时能做什么（I-2、I-10：如实写出，进入设计文档的"局限"一节）
这里说的"被攻破"，是指攻击者在这个进程里获得了任意代码执行能力（比如依赖库被投毒）。**LLM 输出本身不能执行代码**：harness 不执行模型生成的代码，模型只能调用白名单里的工具。

| 被攻破的进程 | **能**做什么 | **不能**做什么 |
|---|---|---|
| **harness** | ① 读出**任意**会话的全部事件（session API 的读接口只需要服务 token）；② 给自己签 fence（它对 `lease:*` 有写权限），所以可以为**任意**处于活动状态的会话申请 hands token（§5.3 的签发条件），然后以那个用户的身份调用 hands 的工具：查机票、读画像、生成报价和出示记录、写或忘记偏好；③ 往任意会话写 `agent.*` 和 `quote.offered` 事件（类型白名单仍然生效）；④ 向任意会话的 `sse:session:*` 频道发布临时事件，往别人的实时画面里塞**假的流式文字**。这些文字不落库，刷新页面后就会消失（§4.4 会做 schema 校验，但内容无法验证）；⑤ 带着 `deepseek_api_key` 出网；⑥ **通过公网访问 Caddy**（egress 网络可以出网，能连到虚拟机的公网地址）。由于 D-08 只要求填用户名，它可以像**任何一个匿名的互联网用户**一样，以任意用户名登录，并确认那个用户已经出示过的报价 | ① 在内网里直连 gateway 的公共端口（§2.2）；② 连 booking、连 postgres；③ 写 `user.*`、`booking.*` 事件；④ 伪造 hands token 里的 uid（拿不到签名私钥）；⑤ 拿到 cookie_secret、booking token、任何数据库密码 |
| **hands** | ① 以 `fb_hands` 的权限读写它有权限的表（读所有用户的机票，写报价、出示记录和偏好）；② 读取 `locations.db` | ① 连 gateway 的公共端口和 booking；② 出网（它不在可以出网的网络里）；③ 写 tickets、events |

**结论**：
- **H-02 和 D-06 的含义是"agent（LLM）没有任何下单途径"**，这一条完全成立：没有下单工具，没有凭证，下单必须由用户在浏览器里点击。
- 一个**被完全攻破的 harness 进程**，在"下单"这件事上的能力，等于 D-08 下任何匿名互联网用户已经具备的能力：知道用户名就能登录，并确认那个用户已经出示过的报价。这不是新的口子，而是 D-08 本身的局限。
- 要彻底关闭，需要同时做两件事：harness 的出网白名单（D-26 的扩展点），和真正的账号鉴权（D-08 的下一步）。是否提前做出网白名单，见 §14.3 的 D-59。

---

## 3. 数据模型和数据归属

### 3.1 实体关系
```
users 1─* sessions 1─* events（只追加）
users 1─* quotes（hands 写，不可变）1─* quote_offers（hands 写，只能插入；每出示一次插入一行）
quotes 1─0..1 tickets（booking 写；tickets.quote_id UNIQUE 保证每个报价只能出一张票，O-1）
sessions 1─* tool_calls（hands 写，只能插入；按 (session, runId, toolCallId) 幂等）
users 1─* user_memories（hands 写，只能插入；按 key 取最新一行）1─0..1 memory_deletions（gateway 写，只能插入）
```
- **会话 = 一次对话**（D-29）："历史对话"就是 sessions 列表，加上每个会话的事件回放。
- **城市名一律存原始的 `city_name`**（R-01 §4 数据陷阱）：`San Jose` 和 `San José` 是两个不同的、都有服务的城市，去掉重音以后完全一样。所以 `quotes.from_city` / `to_city`、`tickets` 的城市字段、`user_memories.value`、所有展示和比较，**一律使用 `locations.db` 里的原文**。去重音和大小写规范化**只用于**城市解析时的模糊匹配（A-02 / flight-core），**不能**用于存储、唯一键或相等比较。

### 3.2 表结构（schema `app`，Postgres 16，时间一律 `timestamptz`，UTC）
```sql
-- ID 格式：前缀 + 26 位随机 Crockford base32（O-7）。例如 'q_7K3F9QX2M8T4H6J1R5N0V2C9BD'
-- users / sessions 用 uuid（只在系统内部使用，不进入 LLM 上下文）

-- 用户（D-08：只填用户名；第一次登录时自动注册，D-30）
CREATE TABLE app.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,                       -- 原样展示
  username_norm text NOT NULL UNIQUE,                -- NFKC + trim + lower；先规范化再校验长度（S-5）
  locale        text NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh','en')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(username_norm) BETWEEN 1 AND 32)
);

-- 会话（对话）。只有 gateway 能写。下面的"消费跟踪"列是 B-3 的核心（§6.4）
CREATE TABLE app.sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app.users(id),
  title               text,                          -- 取第一条用户消息的前 40 个字符，确定性生成，不用 LLM
  locale              text NOT NULL CHECK (locale IN ('zh','en')),
  last_seq            bigint NOT NULL DEFAULT 0,     -- 分配 seq 时用的计数器
  -- 消费跟踪（§6.4）。列名和 A-02 v0.4 §3.1 / §16.3 C-4 一致
  last_user_seq       bigint NOT NULL DEFAULT 0,     -- 最新一条 user.message 的 seq
  last_user_at        timestamptz,                   -- 最新一条 user.message 的落库时间
  oldest_unconsumed_at timestamptz,                  -- 最早一条"还没被消费"的 user.message 的落库时间；没有未消费的输入时为 NULL（§6.4）
  consumed_up_to_seq  bigint NOT NULL DEFAULT 0,     -- 所有 agent.run_started.consumedUpToSeq 的最大值
  open_run_id         text,                          -- 当前未结束的运行；run_started / resumed 时设置，completed / failed 时清空
  last_agent_event_at timestamptz,                   -- 最近一次 harness 写入事件的时间
  last_run_outcome    text CHECK (last_run_outcome IN ('completed','failed')),
  max_fence_seen      bigint NOT NULL DEFAULT 0,     -- emit 成功时见过的最大 fence（D-34）
  -- 只用来显示，由上面几列推导（§6.4）；任何逻辑都不能读它来做判断
  status              text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','queued','running','error')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_updated ON app.sessions (user_id, updated_at DESC, id DESC);
-- sweeper 用：有未消费输入，或者有未结束运行的会话（§7.4）
CREATE INDEX sessions_sweep ON app.sessions (id)
  WHERE last_user_seq > consumed_up_to_seq OR open_run_id IS NOT NULL;

-- 事件日志：只追加（H-05）。只有 gateway 能写
CREATE TABLE app.events (
  session_id      uuid   NOT NULL REFERENCES app.sessions(id),
  seq             bigint NOT NULL,                   -- 每个会话从 1 开始，连续无空洞
  id              uuid   NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  type            text   NOT NULL,                   -- 取值见 §6.3 和 A-02 §2
  actor           text   NOT NULL CHECK (actor IN ('user','agent','system')),
  ts              timestamptz NOT NULL DEFAULT now(),
  trace_id        text   NOT NULL,
  idempotency_key text   NOT NULL,                   -- 每个事件都必须有（格式见 §6.3、A-02 §3.7）
  schema_version  smallint NOT NULL DEFAULT 1,       -- 保留（O-5 不采纳，理由见 §18.3）
  payload         jsonb  NOT NULL,                   -- 键的顺序不保证；需要原样字节的内容放在 payload 里的字符串字段中（D-54：agent.message.messageJson，§6.1）
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, idempotency_key)
);
-- v0.3 的 CHECK (pg_column_size(payload) <= 65536) 已删除（S-14：对 TOAST 压缩后的值不可靠）；大小由 gateway 在写入前检查（§5.1）
CREATE INDEX events_booking_confirmed ON app.events (session_id, idempotency_key)
  WHERE type = 'booking.confirmed';
CREATE FUNCTION app.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME; END $$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON app.events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON app.events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
-- 触发器防的是运行时角色的误操作。owner 可以 DISABLE TRIGGER，所以真正的保证是"运行时没有任何服务使用 owner"（H-05，I-14）

-- 报价：不可变（D-10：不过期）。只有 hands 能写
CREATE TABLE app.quotes (
  id            text PRIMARY KEY CHECK (id ~ '^q_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id       uuid NOT NULL REFERENCES app.users(id),     -- 来自 hands token，不来自 LLM
  session_id    uuid NOT NULL REFERENCES app.sessions(id),  -- 同上
  from_city     text NOT NULL,                              -- locations.db 的 city_name 原文
  to_city       text NOT NULL,
  data_sha256   text NOT NULL,                              -- locations.db 的 sha256
  payload       jsonb NOT NULL,                             -- A-02 §7.2 的 Quote
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_session ON app.quotes (session_id, created_at);
CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON app.quotes
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 报价出示记录（A-02 §7.3 offer_booking）：每出示一次插入一行。只有 hands 能写
CREATE TABLE app.quote_offers (
  quote_id     text NOT NULL REFERENCES app.quotes(id),
  session_id   uuid NOT NULL REFERENCES app.sessions(id),
  tool_call_id text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, tool_call_id)
);
CREATE INDEX quote_offers_session ON app.quote_offers (session_id, quote_id);
CREATE TRIGGER quote_offers_immutable BEFORE UPDATE OR DELETE ON app.quote_offers
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 工具调用的幂等缓存（A-02 §5.1）。只有 hands 能写
-- 主键里加上 run_id（S-15）：不假设厂商的 toolCallId 在整个会话里跨运行唯一。崩溃恢复后 runId 不变（A-02 §3.6），所以重放仍然能命中
CREATE TABLE app.tool_calls (
  session_id   uuid NOT NULL REFERENCES app.sessions(id),
  run_id       text NOT NULL,
  tool_call_id text NOT NULL,
  name         text NOT NULL,
  input_sha256 text NOT NULL,                               -- sha256(canonicalJson(input))（I-5）
  response     jsonb NOT NULL,                              -- 第一次的完整响应 { ok, llmText, data | error }
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, run_id, tool_call_id)
);
CREATE TRIGGER tool_calls_immutable BEFORE UPDATE OR DELETE ON app.tool_calls
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 机票。只有 booking 能写。v0.3 的 quote_redemptions 已删除（O-1）：tickets.quote_id UNIQUE 已经保证每个报价只能出一张票
CREATE TABLE app.tickets (
  id                text PRIMARY KEY CHECK (id ~ '^t_[0-9A-HJKMNP-TV-Z]{26}$'),
  ticket_no         text NOT NULL UNIQUE,                   -- 'OA-' + id 主体的最后 8 位（O-5）
  user_id           uuid NOT NULL REFERENCES app.users(id),
  session_id        uuid NOT NULL REFERENCES app.sessions(id),  -- 等于 quotes.session_id
  quote_id          text NOT NULL UNIQUE REFERENCES app.quotes(id),
  from_city         text NOT NULL,                          -- city_name 原文
  to_city           text NOT NULL,
  itinerary         jsonb NOT NULL,                         -- 报价 payload 的完整快照
  total_distance_km double precision NOT NULL,              -- 未舍入的原始值（D-09）
  price_cents       integer NOT NULL CHECK (price_cents >= 0),  -- 成交价 = 报价的 priceCents（不重新计算）
  status            text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued')),
  booked_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_user ON app.tickets (user_id, booked_at DESC, id DESC);
CREATE TRIGGER tickets_immutable BEFORE UPDATE OR DELETE ON app.tickets
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();       -- 退票不在范围内；以后要做就改成插入 ticket_events

-- 长期记忆（A-02 §9；D-38 只存枚举偏好；D-42 去掉了 avoid_transfer_city）。只有 hands 能写，只能插入
-- 规则："每个 (user_id, key) 取最新一行"。value 为 NULL 表示 forget_preference（墓碑）
CREATE TABLE app.user_memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES app.users(id),
  key               text NOT NULL CHECK (key IN ('home_city','preferred_language')),   -- S-6
  value             text,                                   -- city_name 原文，或语言枚举；NULL = 已忘记
  source_session_id uuid NOT NULL REFERENCES app.sessions(id),
  source_seq        bigint NOT NULL,                        -- 触发这条记忆的 user.message 的 seq（来自 execute 信封的 inputSeq，I-6）
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)                                      -- 给 memory_deletions 的复合外键用
);
CREATE INDEX user_memories_latest ON app.user_memories (user_id, key, created_at DESC, id DESC);
CREATE TRIGGER user_memories_immutable BEFORE UPDATE OR DELETE ON app.user_memories
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- 记忆删除（用户在画像面板里操作）。只有 gateway 能写，只能插入
CREATE TABLE app.memory_deletions (
  memory_id  uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (memory_id, user_id) REFERENCES app.user_memories (id, user_id)   -- S-6：只能删自己的记忆
);
```
设计说明：
- 除了 `users.locale` 和 `sessions` 的几个状态列以外，**所有业务表都只能插入**。"修改"一律用新增一行来表示（出示、墓碑、删除标记）。所以每张表**只有一个写入方**，数据归属可以直接靠授权语句检查。
- **记忆的有效值**（hands 召回时使用，T10 必须有单元测试）：对每个 `(user_id, key)`，只看**最新的那一行**（按 `created_at DESC, id DESC`）；如果它的 `value IS NULL`，或者它在 `memory_deletions` 里，这个 key 就**不存在**。**不会回退到更旧的值**，所以用户删除之后，旧值不会"复活"（A-02 §16.2 X-3 已同意）。
- 用户删除记忆后，原始行仍然保留（可审计），只是不再被召回，也不再展示（D-32）。记忆的整理和合并是独立的后台流程，v1 不做（§17）。
- 派生画像（常飞航线等，A-02 §9.1）是 hands 每次读取时根据 `tickets` 实时计算的，不需要表。

### 3.3 数据库角色和授权（T05 照抄，契约测试逐条验证）
```sql
-- fb_owner：只给 migrate 容器用，拥有所有表；运行时没有任何服务使用它（它的密码只挂进 migrate 和 postgres，§2.3）
-- harness 没有数据库角色（H-06）
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO fb_gateway, fb_hands, fb_booking;

-- gateway（公共 API、session API 和 sweeper 都在这个进程里，共用这个角色）
GRANT SELECT, INSERT              ON app.users            TO fb_gateway;
GRANT UPDATE (locale)             ON app.users            TO fb_gateway;
GRANT SELECT, INSERT              ON app.sessions         TO fb_gateway;
GRANT UPDATE (title, last_seq, last_user_seq, last_user_at, oldest_unconsumed_at, consumed_up_to_seq, open_run_id,
              last_agent_event_at, last_run_outcome, max_fence_seen, status, updated_at)
                                  ON app.sessions         TO fb_gateway;
GRANT SELECT, INSERT              ON app.events           TO fb_gateway;
GRANT SELECT                      ON app.quotes           TO fb_gateway;
GRANT SELECT                      ON app.quote_offers     TO fb_gateway;   -- 校验 harness 写入的 quote.offered
GRANT SELECT                      ON app.tickets          TO fb_gateway;   -- 视图、sweeper 对账
GRANT SELECT                      ON app.user_memories    TO fb_gateway;
GRANT SELECT, INSERT              ON app.memory_deletions TO fb_gateway;

-- hands
GRANT SELECT (id, user_id, last_user_seq) ON app.sessions TO fb_hands;   -- 校验 token 里的 sid / uid；校验 inputSeq 是否合理
GRANT SELECT, INSERT              ON app.quotes           TO fb_hands;
GRANT SELECT, INSERT              ON app.quote_offers     TO fb_hands;
GRANT SELECT, INSERT              ON app.tool_calls       TO fb_hands;
GRANT SELECT                      ON app.tickets          TO fb_hands;     -- list_my_tickets、派生画像、offer_booking 判断是否已出票
GRANT SELECT, INSERT              ON app.user_memories    TO fb_hands;
GRANT SELECT                      ON app.memory_deletions TO fb_hands;

-- booking
GRANT SELECT                      ON app.quotes           TO fb_booking;
GRANT SELECT                      ON app.quote_offers     TO fb_booking;
GRANT SELECT, INSERT              ON app.tickets          TO fb_booking;
```
**归属矩阵**（W = 唯一写入方，R = 只读，— = 不能访问）：
| 表 | gateway | hands | booking | harness |
|---|---|---|---|---|
| users | W | — | — | — |
| sessions | W | R（3 列） | — | — |
| events | W（只能插入） | — | — | —（只能经 session API） |
| quotes | R | W（只能插入） | R | — |
| quote_offers | R | W（只能插入） | R | — |
| tool_calls | — | W（只能插入） | — | — |
| tickets | R | R | W（只能插入） | — |
| user_memories | R | W（只能插入） | — | — |
| memory_deletions | W（只能插入） | R | — | — |

### 3.4 迁移和角色
- `infra/db/migrations/NNNN_name.sql` 只往前走，不回滚。`migrate` 容器用 `fb_owner` 执行，记录到 `app.schema_migrations`，执行完就退出。
- 用自己写的执行器（几十行），不引入迁移库。
- 角色（`fb_owner`、`fb_gateway`、`fb_hands`、`fb_booking`）和它们的密码由 postgres 容器第一次初始化时的 `infra/db/init/00-roles.sh` 创建（§2.3）。GRANT 语句由 migrate 执行（它是这些表的 owner）。

---

## 4. 公共 API（浏览器 ↔ gateway:8080）

### 4.1 通用约定
- 前缀 `/api/v1`；JSON；字段用 camelCase；时间用 ISO 8601 UTC。
- 所有请求体都做 schema 校验，`additionalProperties: false`（H-08）。请求体上限 16 KB。
- **schema 一律用 TypeBox 定义**（D-24），放在 contracts 里。Fastify 通过 TypeBox 的 type provider 直接使用这些 schema。所有服务的 HTTP 入口都一样（gateway 的两个端口、booking、hands）。
- **Fastify 的 ajv 必须这样配置**（D-24）。这个配置写死在 `@fb/platform/fastify` 的工厂函数里，各服务不能自己覆盖：
  ```ts
  ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false } }
  ```
  原因：Fastify 默认的 ajv 配置是 `coerceTypes: 'array'`、`removeAdditional: true`、`useDefaults: true`。这意味着多余的字段会被**悄悄删掉**而不是报错（比如有人塞了一个 `userId`，请求照样成功），`"123"` 也会被悄悄转成 `123`。这两点都和 H-08 冲突。配置成上面这样以后，多余字段和类型错误都会返回 `400 VALIDATION_FAILED`。
  - 查询参数本来就是字符串，所以它们的 schema 用 `Type.String({ pattern: '^[0-9]+$' })` 定义，再在 handler 里显式转换，不依赖类型转换。
- 后端返回的 `message` 只是给开发者看的英文说明。**给用户看的文案由前端根据 `code` 查 i18n 表生成**（§9.6，R-U1）。
- **请求体里永远不出现 `userId`**（H-04）。身份只来自 `fb_sid` cookie。契约测试会扫描所有公共请求的 schema。
- 别人的资源一律返回 **404**（不返回 403），不泄露资源是否存在。
- 新建资源返回 `201`，异步受理返回 `202`，幂等重放返回 `200`。
- 每个响应都带 `X-Trace-Id` 头。
- **错误信封**（所有服务共用，包括 booking 和内部 API，S-1）：
```ts
interface ApiError { error: { code: ErrorCode; message: string; details?: unknown; traceId: string } }
```
- **列表分页**（S-3）：`cursor` 是 base64url 编码的 JSON，`{ "k": <排序键的值>, "i": <id> }`。
  - `GET /sessions` 按 `(updated_at DESC, id DESC)` 排序。由于 `updated_at` 会变，翻页时**可能出现重复或遗漏**。前端按 id 去重；需要完整列表时，从第一页重新拉取。会话数量很少，这样做是可以接受的。
  - `GET /tickets` 按 `(booked_at DESC, id DESC)` 排序。这两个字段都不会变，所以翻页是稳定的。

### 4.2 鉴权、cookie 和 CSRF（I-8）
- `POST /auth/login` 成功后：
  - **轮换会话**：如果请求带着旧的 `fb_sid`，先删除旧会话，再新建一个；
  - 设置两个 cookie：`fb_sid`（随机 32 字节，`HttpOnly; SameSite=Strict; Path=/`，拿到域名后加 `Secure`，D-23）和 `fb_csrf`（随机 32 字节，**不是** HttpOnly，前端要读它）；
  - Redis 里存 `auth:sess:{sid}` → `{ userId, csrf, createdAt }`，TTL 7 天，每次请求时续期。
- **非 GET 请求的检查规则**（任何一条不满足都返回 `403 CSRF_INVALID`）：
| 请求 | `Origin` 等于 `PUBLIC_ORIGIN` | `X-CSRF-Token` 等于会话里的 csrf | `Content-Type: application/json` |
|---|---|---|---|
| `POST /auth/login` | ✅ 必须 | **豁免**（这时还没有会话） | ✅ 必须 |
| 有请求体的写请求（`POST /sessions`、`POST /sessions/:id/messages`、`PATCH /me`） | ✅ | ✅ | ✅ |
| **没有请求体**的写请求（`POST /auth/logout`、`POST /quotes/:quoteId/confirm`、`DELETE /profile/memories*`） | ✅ | ✅ | **不检查**。前端**不能**发送 `Content-Type` 头，也不能带请求体；如果带了请求体，返回 400。这样可以避开 Fastify 在"声明了 JSON 但请求体为空"时返回的 `FST_ERR_CTP_EMPTY_JSON_BODY` |
- **`POST /quotes/:quoteId/confirm` 是唯一的下单入口**，所以额外有一层防护：Caddy 对所有页面统一设置 `Content-Security-Policy: frame-ancestors 'none'` 和 `X-Frame-Options: DENY`，防止点击劫持骗用户点按钮。
- **退出登录**：删除 Redis 里的会话，并**关闭这个 sid 的所有 SSE 连接**（S-4）。gateway 在内存里维护 sid → SSE 连接的映射；多副本时，通过 `sse:logout` 频道广播。

### 4.3 接口清单
| 方法 路径 | 请求 | 成功响应 | 主要错误 | 说明 |
|---|---|---|---|---|
| `POST /auth/login` | `{ username: string(1..64) }` | 200 `{ user: UserView }` | 400 `VALIDATION_FAILED` | 不存在就自动注册（D-30）。**先做 NFKC + trim + lower，再校验长度 1..32**，超长返回 400，不会因为 DB 的 CHECK 失败而返回 500（S-5） |
| `POST /auth/logout` | 没有请求体 | 204 | — | §4.2 |
| `GET /me` | — | 200 `{ user: UserView }` | 401 `AUTH_REQUIRED` | |
| `PATCH /me` | `{ locale: 'zh'\|'en' }` | 200 `{ user }` | 400 | 界面语言 |
| `GET /sessions` | `?cursor&limit≤50` | 200 `{ items: SessionView[], nextCursor? }` | 401 | 分页见 §4.1（G-09） |
| `POST /sessions` | `{ locale?: 'zh'\|'en' }` | 201 `{ session }` | 401 | **不再写 `session.created` 事件**（O-8）：locale 保存在 sessions 表里。会话的第一个事件就是第一条 `user.message`（seq 1） |
| `GET /sessions/:id` | — | 200 `{ session }` | 404 `SESSION_NOT_FOUND` | |
| `GET /sessions/:id/events` | `?afterSeq=0&limit≤200` | 200 `{ events: PublicEvent[], hasMore }` | 404 | **返回裁剪后的公共视图**（§4.5，I-4），不是内部的 EventEnvelope；用于历史回放和补齐断档 |
| `GET /sessions/:id/stream` | 请求头 `Last-Event-ID` 或 `?afterSeq=` | `text/event-stream` | 404 | §4.4 |
| `POST /sessions/:id/messages` | `{ text: string(1..2000), clientMessageId: uuid }` | 202 `{ event: PublicEvent }`；重放时 200 | 404；409 `IDEMPOTENCY_CONFLICT` | 见下文 |
| `GET /quotes/:quoteId` | — | 200 `{ quote: QuoteView }` | 404 `QUOTE_NOT_FOUND` | **报价卡唯一的数据来源**；要求 `quote.user_id = 当前用户` |
| `POST /quotes/:quoteId/confirm` | **没有请求体**（O-3） | 201 `{ ticket: TicketView }`；200 `{ ticket, alreadyBooked: true }` | 404 `QUOTE_NOT_FOUND`；409 `QUOTE_NOT_OFFERED`；503 `BOOKING_UNAVAILABLE` | §5.2；**唯一的下单入口**。报价绑定在哪个会话上，由 booking 从报价里读出，不由客户端传入 |
| `GET /tickets` | `?cursor&limit≤50` | 200 `{ items: TicketView[], nextCursor? }` | 401 | 我的机票页面（G-08 的界面入口；自然语言查询走 agent） |
| `GET /tickets/:ticketId` | — | 200 `{ ticket }` | 404 `TICKET_NOT_FOUND` | |
| `GET /profile` | — | 200 `{ preferences: MemoryView[] }` | 401 | 只返回每个 key 的**有效值**（§3.2 的规则） |
| `DELETE /profile/memories/:memoryId` | 没有请求体 | 204 | 404 `MEMORY_NOT_FOUND` | 插入一条 memory_deletions；重复删除也返回 204。在 agent 的下一次运行生效（A-02 §9.2） |
| `DELETE /profile/memories` | 没有请求体 | 204 | — | 删除全部有效偏好 |
| `GET /healthz` | — | 200 `{ ok: true }` | — | 不需要鉴权，不暴露任何细节 |

`POST /sessions/:id/interrupt`（停止按钮）**不在 v1 里**（D-33）。

**`POST /sessions/:id/messages` 的处理步骤**（一个事务）：
1. 转义（见下文），得到 `escapedText`。
2. `idempotency_key = 'user:' + clientMessageId`（S-17）。如果这个 key 已经存在：存下来的 `text` 等于 `escapedText` → 返回 200 和原来的事件；不相等 → 409 `IDEMPOTENCY_CONFLICT`。
   - 比较的是**转义后**的文本（S-17 的建议是比较原文，**不采纳**）：转义是确定性的，两段原文转义后相同，意味着 LLM 看到的内容完全相同，当作同一条消息处理不会有任何问题；而为了比较原文，还得多存一份原文的哈希。
3. 写入 `user.message`，同时更新消费跟踪：`last_user_seq = seq`、`last_user_at = now()`（§6.4）。
4. 提交以后按门铃（§7.3）。门铃失败不影响 202 响应，由 sweeper 兜底（§7.4）。

**user.message 的转义**（A-02 R-7；S-7 加强）：
- 函数 `neutralizeTags(text)` 放在 `@fb/contracts/server`。gateway 写入时调用一次，A-02 的 projector 再调用一次（双保险）。
- 算法：
  1. 先对文本做 **NFKC**，这样全角的 `＜` 会变成 `<`；
  2. 用正则（不区分大小写）匹配：`(<|&lt;|&#0*60;|&#x0*3c;)\s*/?\s*(system_event|run_context)`；
  3. 把匹配到的开头部分替换掉：`<` 换成 `&lt;`；实体形式（`&lt;`、`&#60;` 等）在前面再加一个 `&amp;`，变成"实体的实体"。
- 结果：所有能被模型当成这两个标签的写法，都会变成明显的纯文本。红队用例（T13）要覆盖：带空格、全角、HTML 实体、大小写混合，以及带 `/` 的闭合标签。
- 副作用：用户如果真的输入了这几种写法，历史里会显示成转义后的样子。这写进"局限"一节。

### 4.4 SSE 事件流
- 建立连接时：先补发 `seq > afterSeq` 的已落库事件，再切换到实时推送。补发和实时之间的竞态这样处理：**先订阅 Redis 频道，再查数据库**，然后按 seq 去重。
- 帧格式：
  - `event: evt`，`id: <seq>`，`data: PublicEvent`（已落库的事件，可以按 seq 续传）；
  - `event: eph`，没有 id，`data: PublicEphemeral`（`agent.delta`、`agent.tool_status`，不落库，断线就丢掉。A-02 v0.4 已删除 `agent.status`）；
  - `event: status`，`data: { status }`（会话的显示状态变化）；
  - 每 15 秒发一行注释 `: ping` 做心跳。另外发 `retry: 3000`。
- **gateway 怎么处理 Redis 上的通知**（S-4）：
  - `{kind:'evt', seq}`：**只当作"有新事件"的信号**。gateway 回数据库按 seq 读取事件，裁剪成 `PublicEvent` 以后再推送，**不转发通知里的任何内容**；
  - `{kind:'eph', event}`：依次检查：① 按 `@fb/contracts/server` 里对应临时事件的 schema 校验；② `event.sessionId` 等于频道名里的 sid；③ **fence**（A-02 v0.4 §2.2 / §16.3 C-7）：临时事件的信封带着发送方的 `fence`，如果 `fence < GET lease:fence:{sid}` 就丢弃，这样旧 worker 推不出文字，也撤不掉别人的文字（gateway 按会话缓存这个值 1 秒，避免每条 delta 都访问一次 Redis）；④ **大小**：单个临时事件不超过 4 KB。全部通过才裁剪成 `PublicEphemeral` 转发，否则丢弃并记 warn 日志。
    - v0.5 的 `AGENT_DELTA_MODE=off` 默认值**已去掉**（D-64 🔁）：`agent.delta` 和 `agent.reasoning_delta` 默认照常转发。这个开关保留为运维用的应急开关，默认值是 `stream`；设为 `off` 时，过程区不再有实时内容，只显示落库后的折叠过程（§9.4.1）。
    - gateway **不检查**过程区文字里的数字是否已经打码：打码是 harness 的职责（D-64 的安全约束，§16.3 A2-17），gateway 拿不到本次运行的工具结果，也就无法判断。
  - 这能挡住格式错误或者串到别的会话的消息，但**挡不住**一个被攻破的 harness 往合法格式里塞假文字（§2.7）。
- 前端收到的 seq 如果比本地最大 seq 大不止 1，就用 `GET /events?afterSeq=` 补齐缺失的部分。
- Caddy 对这个路径设置 `flush_interval -1`，不缓冲。

### 4.5 视图类型（放进 `@fb/contracts/web`）
```ts
interface UserView    { id: string; username: string; locale: 'zh'|'en' }
interface SessionView { id: string; title: string|null; locale: 'zh'|'en';
                        status: 'idle'|'queued'|'running'|'error';      // 只用于显示（§6.4）
                        lastSeq: number; createdAt: string; updatedAt: string }
interface QuoteView   { sessionId: string;
                        quote: Quote;            // A-02 §7.2：quoteId、from、to、legs、transferCities、totalDistanceKm（原始值）、
                                                 // priceCents、display（已格式化：legs[]、totalDistanceKm、priceUsd）、dataSha256、createdAt
                        booking: { status: 'available' } | { status: 'booked'; ticketId: string; ticketNo: string } }
interface TicketView  { ticketId: string; ticketNo: string; sessionId: string; quoteId: string;
                        from: string; to: string;           // city_name 原文
                        itinerary: Quote;                   // 报价的快照；展示时用 itinerary.display
                        priceCents: number; bookedAt: string }
interface MemoryView  { memoryId: string; key: 'home_city'|'preferred_language'; value: string; createdAt: string;
                        source: { sessionId: string; seq: number } }   // 可以跳转到用户当时的原话
```
`Quote.display` 由 flight-core 用 `@fb/contracts/server` 里**唯一一个**格式化函数生成，落库后不再变化。前端只负责展示，不自己舍入。这样卡片、机票、agent 文本的数字守卫用的是同一套口径（H-01 / D-09，A-02 §7.6）。

**公共事件视图 `PublicEvent`**（I-4）：
- gateway 在 REST 和 SSE 两个出口用**同一个**裁剪函数 `toPublicEvent()`，把内部的 `EventEnvelope` 转成 `PublicEvent`。
- `@fb/contracts/web` **只导出** `PublicEvent`，不导出 `EventEnvelope`。
- 原则：**白名单**，只保留前端需要的字段，没有列出的字段一律去掉。这样以后 A-02 给 payload 加字段时，不会意外泄露给浏览器。

```ts
interface PublicEvent<T extends PublicEventType = PublicEventType> {
  seq: number; type: T; actor: 'user'|'agent'|'system'; ts: string; payload: PublicPayloadOf<T>
}
```
| 内部事件 | 公共的 `type` | 公共的 `payload`（只保留这些字段） |
|---|---|---|
| `user.message` | 原样 | `{ text, clientMessageId }` |
| `agent.message`，`role = assistant`，**不带**工具调用（最终回复） | 原样 | `{ runId, messageKey, kind: 'reply', text }`：`text` **只取 A-02 给出的 `viewText`**（已经通过守卫的文字）。gateway **不解析** `messageJson`。如果 payload 里有 `meta.template`，保留成 `template: string`。**去掉** `messageJson`、`n`、`attempt`、`piVersion` |
| `agent.message`，`role = assistant`，**带**工具调用（ReAct 中间步骤，D-63 / D-64 🔁） | 原样 | `{ runId, messageKey, kind: 'process', processText }`：`processText` **只取 A-02 给出的 `processText` 字段**（这条消息的文字，其中不在本次运行工具结果里的数字已经由 harness 打码，§16.3 A2-17）。gateway 根据 `hasToolCalls === true` 判断（A2-12），**绝不**把这类消息的文字放进 `text`，所以它不会显示成普通气泡。thinking（reasoning）**不进入**落库后的公共视图，它只在运行期间以临时事件短暂显示（§9.4.1）。`processText` 缺失时当作空字符串 |
| `agent.message`，`role = toolResult` | 原样 | `{ runId, messageKey, toolCallId, toolName, isError }`（字段名和 A-02 v0.4 §2.3 一致）。**去掉** `messageJson` 和 `data` |
| `agent.message`，`role = system` | **`hidden`** | `{}`：只保留 seq，这样前端的序号仍然连续。**系统提示词和 `toolsAdded` 绝不出现在公共响应里** |
| `agent.run_started` | 原样 | `{ runId }`（去掉 profile、model、promptVersion 等） |
| `agent.run_resumed` | 原样 | `{ runId, attempt }` |
| `agent.run_completed` | 原样 | `{ runId }`（去掉 usage） |
| `agent.run_failed` | 原样 | `{ runId, code }` |
| `agent.guard_violation` | 原样 | `{ runId, messageKey, action }`，`action ∈ {"regenerate","replaced"}`（A-02 v0.4 §2.1）。去掉 `offending` 和 `guard`，以免把被拦截的错误数字显示给用户 |
| `agent.context_compacted`（D-52 ✅） | **`hidden`** | `{}`。压缩摘要只给 LLM 用，不给用户看；历史回放仍然显示压缩之前的全部原始事件 |
| `quote.offered` | 原样 | `{ quoteId }` |
| `booking.confirmed` | 原样 | `{ quoteId, ticketId, ticketNo }`（去掉 summary；前端以 API 为准） |
| `booking.failed` | 原样 | `{ quoteId, code }` |
| 以后新增、但没有登记在这张表里的类型 | **`hidden`** | `{}`（默认安全） |

临时事件的公共视图 `PublicEphemeral`（D-64：都是过程区的内容）：
| 临时事件 | 公共 payload | 说明 |
|---|---|---|
| `agent.delta` | `{ runId, messageKey, textDelta }` 或 `{ runId, messageKey, reset: true }` | 模型流式输出的文字。harness 推送前已经对数字打码（A2-17） |
| `agent.reasoning_delta`（**新增**，D-64） | `{ runId, messageKey, textDelta }` | 推理文本（reasoning / thinking）的流式片段，同样由 harness 打码后推送。**不会出现在落库后的公共视图里**，断线就丢 |
| `agent.tool_status` | `{ runId, toolCallId, name, phase, isError? }` | 过程区里的工具步骤 |

信封里的 `fence` 不转发给浏览器。（A-02 v0.4 已删除 `agent.status`。）`agent.reasoning_delta` 的内部定义和打码规则由 A-02 补上（§16.3 A2-17）；A-01 只定义它的通道（`sse:session:{sid}` 的 `eph`）和公共形状。

T06 的测试：对每一种内部事件构造一个"所有字段都填满"的样例，断言公共响应里**不会出现** `messageJson`、thinking 块、system 消息的文本、toolResult 的 `data`、`profile`、`offending`、压缩摘要；并且**带工具调用的 assistant 消息一律是 `kind:'process'`，文字只出现在 `processText` 里，永远不出现在 `text` 里**（D-63 / D-64）。

**`TicketSummary`**（C-8：之前双方都说"由 contracts 冻结"，但谁都没写；这里给出定义，由 gateway 生成）：
```ts
interface TicketSummary {
  ticketNo: string; from: string; to: string;            // city_name 原文
  legs: Array<{ from: string; to: string }>; transferCities: string[];
  display: { legs: string[]; totalDistanceKm: string; priceUsd: string }   // 直接复制报价的 display，没有新算的数字
}
```
它只出现在内部的 `booking.confirmed.payload.summary` 里，给 A-02 的投影和 numberGuard 使用；公共视图里不包含它。

### 4.6 错误码（放进 contracts）
**规则：同名必须同义**（S-8）。A-01 和 A-02 §5.3 的错误码放进同一个 `ErrorCode` 枚举。两边可以使用同一个代码，但含义必须相同。

| 代码 | HTTP | 含义 |
|---|---|---|
| `AUTH_REQUIRED` | 401 | 没有登录，或者会话已过期 |
| `CSRF_INVALID` | 403 | Origin、CSRF token 或 Content-Type 校验没通过（§4.2） |
| `FORBIDDEN_PEER` | 403 | 连接来源地址不在允许的范围里（§2.2） |
| `VALIDATION_FAILED` | 400 | schema 校验失败 |
| `PAYLOAD_TOO_LARGE` | 413 | |
| `SESSION_NOT_FOUND` / `QUOTE_NOT_FOUND` / `TICKET_NOT_FOUND` / `MEMORY_NOT_FOUND` | 404 | **在调用方的可见范围内不存在**：公共 API 的范围是"当前用户"，hands 工具的范围是"当前会话"（A-02 §5.3）。两边含义相同，只是范围由调用方决定（S-8） |
| `IDEMPOTENCY_CONFLICT` | 409 | 幂等键相同，但内容不同 |
| `QUOTE_NOT_OFFERED` | 409 | 报价从来没有在它所属的会话里出示过（§5.2） |
| `BOOKING_UNAVAILABLE` | 503 | booking 超时或不可用（重试是安全的） |
| `SERVICE_UNAVAILABLE` | 503 | 依赖不可用（数据库、Redis）（S-1） |
| `FENCE_STALE` | 409 | 只用于内部 API：fence 已经过时，或者刚刚因为 Redis 数据丢失被重置（§5.1） |
| `EVENT_TYPE_FORBIDDEN` | 403 | 只用于内部 API：harness 写了不允许它写的事件类型 |
| `EVENT_INVALID` | 400 | 只用于内部 API：payload 不符合 schema、超过大小限制，或者 `quote.offered` 没有对应的出示记录 |
| `SERVICE_AUTH_INVALID` | 401 | 只用于内部 API：服务 token 或 hands token 无效 |
| `SESSION_INACTIVE` | 409 | 只用于内部 API：会话既没有未消费的输入，也没有未结束的运行，所以不签发 hands token（§5.3） |
| `INTERNAL` | 500 | 未预期的错误 |

v0.3 的 `QUOTE_SESSION_MISMATCH` 已删除（O-3）。

**booking → 公共 API 的映射**（S-1）：
| booking 返回 | gateway 返回给浏览器 | 是否写 `booking.failed` |
|---|---|---|
| 201 `{ ticket }` | 201 `{ ticket: TicketView }` | 否（写 `booking.confirmed`） |
| 200 `{ ticket, alreadyBooked: true }` | 200，原样 | 否（如果对应的 `booking.confirmed` 还没写，就补写，§5.2） |
| 404 `QUOTE_NOT_FOUND` | 404 `QUOTE_NOT_FOUND` | 否（不能在别人的会话里留痕） |
| 409 `QUOTE_NOT_OFFERED` | 409 `QUOTE_NOT_OFFERED` | 是 |
| 400 / 401（说明 gateway 和 booking 之间的契约出了问题） | 500 `INTERNAL`，并记 error 日志 | 否 |
| 5xx、超时、连接失败 | 503 `BOOKING_UNAVAILABLE` | 否 |

---

## 5. 内部 API

### 5.1 session API（gateway:8081，只给 harness 用）
- 单独一个 Fastify 实例，**只绑定在 app 网卡**（`172.30.2.20:8081`），只接受来自 harness 地址段的连接（§2.2）。公共端口上不注册任何 `/internal/*` 路由（测试：通过 Caddy 请求 `/api/v1/../internal/...` 等路径都返回 404）。
- 鉴权：`Authorization: Bearer <harness_service_token>`，用常量时间比较。写操作和申请 hands token 时还要带 `X-Lease-Fence: <整数>`（A-02 §3.2）。
- 接口的 HTTP 形状由 A-01 负责；**调用时机、幂等键怎么取、租约语义由 A-02 定**（W1-seams，A-02 §3）。

| 方法 路径 | 请求 | 响应 | 对应 Managed Agents |
|---|---|---|---|
| `GET /internal/v1/sessions/:id` | — | `{ id, locale, lastSeq }`（**不返回 userId**） | `getSession` |
| `GET /internal/v1/sessions/:id/events` | `?afterSeq=0&limit≤500`（按 seq 升序） | `{ events: EventEnvelope[], hasMore }`（内部的完整事件） | `getEvents`（A-02 R-1） |
| `POST /internal/v1/sessions/:id/events` | 请求头 `X-Lease-Fence`；`{ type, payload, idempotencyKey }`（**一次一个事件**，O-2） | 201 `{ seq, id }`（新写入）；200 `{ seq, id, deduplicated: true }`（重放） | `emitEvent` |
| `POST /internal/v1/sessions/:id/hands-token` | 请求头 `X-Lease-Fence` | 200 `{ token, expiresAt }` | 按 session 关联凭证（§5.3） |

**为什么改成一次写一个事件**（O-2，同时解决 I-7）：A-02 本来就是一次写一条。批量接口带来了"部分重复时 n 是多少""留下空洞"这些难题，一次一条就都不存在了。D-44 并行执行工具时，toolResult 仍然由 harness 按 assistant 消息里的原始顺序一条条写入（A-02）。

**emitEvent 的处理步骤**（一个 Postgres 事务；任何一步失败都回滚，不写入）：
1. **大小和 schema**：请求体原始字节数不超过 **64 KB**（和 A-02 v0.4 §16.3 C-6 一致：D-54 之后 `agent.message` 只存一份 `messageJson`，不再重复保存结构化消息）；`type` 在白名单里（第 3 步）；payload 按 `@fb/contracts/server` 里对应类型的 schema 校验。不通过就返回 `400 EVENT_INVALID`（S-14）。
   - 额外的一致性校验：`agent.run_started` 的 `consumedUpToSeq` 必须等于 `max(inputSeqs)`，并且不超过 `last_user_seq`；`inputSeqs` 里的每个 seq 都必须是本会话里的 `user.message`。不满足就返回 `400 EVENT_INVALID`。
2. **锁住会话行**：`SELECT last_seq, max_fence_seen, … FROM sessions WHERE id = $1 FOR UPDATE`。同一个会话的所有写入在这里串行化。
3. **类型白名单**（A-02 R-3）：harness 只能写 `agent.run_started`、`agent.run_resumed`、`agent.message`、`quote.offered`、`agent.guard_violation`、`agent.run_completed`、`agent.run_failed`、**`agent.context_compacted`**（D-52 ✅）。其他类型返回 `403 EVENT_TYPE_FORBIDDEN`。白名单作为常量放在 `@fb/contracts/server` 里，并有契约测试。
   - **所有这些类型都只能经由 session API 写入，并且都必须带有效的 fence**（第 4 步对每一次写入都执行，没有例外）。`agent.context_compacted` 也一样：它由 harness 里的 compactor 在运行开始之前写入（D-52），gateway 不会自己写它，公共 API 也写不了它。
4. **fence 校验**（A-02 R-2、D-34；I-3）：在 Redis 里原子执行下面的 Lua 脚本，`m` 是第 2 步读到的 `max_fence_seen`：
   ```lua
   -- KEYS[1] = lease:fence:{sid}    ARGV[1] = f（请求里的 fence）    ARGV[2] = m（数据库里的 max_fence_seen）
   local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
   local f, m = tonumber(ARGV[1]), tonumber(ARGV[2])
   if cur < m then                       -- Redis 的 fence 比数据库记录的还小：Redis 数据丢了，或者被重置过
     redis.call('SET', KEYS[1], m + 1)   -- 抬到比所有已知 fence 都大
     return 'RESET'
   end
   if f < cur then return 'STALE' end
   return 'OK'
   ```
   - `STALE` 或 `RESET` → 返回 `409 FENCE_STALE`。
   - 正常情况下一定有 `cur >= m`，因为 `m` 记录的都是曾经通过校验的 fence。
   - Redis 数据丢失以后：持有旧 fence（比如 57）的 worker 来写 → `cur = 0 < m = 57` → 把 fence 设成 58，返回 STALE，旧 worker 停下。新 worker 下一次 INCR 得到 59，可以正常写入；旧 worker 的 57 从此一直小于 59，永远写不进来。
   - 不需要 v0.3 里的"哨兵 key"，也不需要在恢复前拒绝所有 emit。
5. **`quote.offered` 的额外校验**：payload 必须**严格符合** `{ runId, quoteId, toolCallId }`（`additionalProperties: false`），并且 `quote_offers` 里必须有 `(quote_id, tool_call_id)` 这一行，而且它的 `session_id` 等于本会话。否则返回 `400 EVENT_INVALID`。
6. **幂等**：先查 `(session_id, idempotency_key)`。已经存在：类型和 payload 的 `canonicalJson` 都相同 → 返回 200 `{ seq, id, deduplicated: true }`；不同 → `409 IDEMPOTENCY_CONFLICT`。
7. **写入**：`seq = last_seq + 1`，INSERT 事件；更新 `last_seq`、`updated_at`、`max_fence_seen = GREATEST(max_fence_seen, f)`；按 §6.4 更新消费跟踪和显示状态。
   - 如果 INSERT 遇到 `(session_id, idempotency_key)` 的唯一冲突（理论上不会发生，因为第 2 步已经锁住了会话行），回滚整个事务，回到第 2 步重试一次。
8. 提交以后，向 `sse:session:{sid}` 发布 `{kind:'evt', seq}`（§7）。

剩下的时间窗口（如实写出，进入"局限"一节）：
- 第 4 步读的是 Redis，第 7 步提交的是 Postgres，两者之间有一个毫秒级的窗口。只有当旧 worker 的租约**恰好**在这段时间里过期、新 worker 又**恰好**拿到锁时，旧 worker 才可能再写进**一个**事件；新 worker 不一定能在自己的上下文里看到它。
- 后果最多是日志里多出一条旧运行的消息。**不会出票**（harness 没有下单能力），也不会破坏 seq 的连续性。A-02 的 projector 按 runId 和 attempt 处理（A-02 §3.6、§4.2）。
- 完全关闭这个窗口需要 D-34 的方案 B（fence 完全放进 Postgres），写进"下一步"。

### 5.2 确认下单链路（浏览器 → gateway → booking）
```
浏览器 [确认下单] 按钮
  │ POST /api/v1/quotes/:qid/confirm   （没有请求体；cookie + CSRF + Origin，§4.2）
  ▼
gateway
  1. 鉴权，拿到 userId（来自 cookie）
  2. POST 172.30.3.30:8083/internal/v1/bookings
       { quoteId, userId, requestId = traceId }   Bearer <booking_service_token>，超时 5s
  ▼
booking（一个事务，隔离级别 READ COMMITTED）
  a. SELECT * FROM quotes WHERE id = $q AND user_id = $u               → 没有就 404 QUOTE_NOT_FOUND
  b. 查 quote_offers 里有没有 quote_id = $q 且 session_id = quotes.session_id 的记录
                                                                        → 没有就 409 QUOTE_NOT_OFFERED
  c. 生成 ticketId = 't_' + 26 位随机，ticketNo = 'OA-' + ticketId 主体的最后 8 位
     INSERT INTO tickets (...) VALUES (...) ON CONFLICT (quote_id) DO NOTHING RETURNING *
       没有返回行（这个报价已经出过票）→ 查出已有的 ticket，返回 200 { ticket, alreadyBooked: true }
       ticket_no 或 id 的唯一冲突（概率极低）→ 在事务里换一个新 id 重试，最多 3 次（S-13）
     itinerary = 报价 payload 的完整快照；price_cents = 报价的 priceCents（不重新计算）；session_id = quotes.session_id
  d. COMMIT → 201 { ticket }
  ▼
gateway
  3. 以系统身份往 ticket.sessionId 写入 booking.confirmed：
       { quoteId, ticketId, ticketNo, summary: TicketSummary }，idempotencyKey = 'booking:' + quoteId（A-02 R-9）
  4. **不按门铃，不唤醒 harness**（D-39：出票后 agent 不说话）
  5. 把结果返回给浏览器 → 前端渲染**系统出票卡片**（§9.3.1）
```
- agent 什么时候知道已经出票：`booking.*` **不是输入**，不会进入任何运行的 `inputSeqs`（A-02 §2.4）。用户下一次发消息时，projector 会把运行期间到达的 `booking.*` 挂到那次运行的边界上，放在 run_context 之前（D-55 ✅，A-02 §4.2）。
- **和 `consumed_up_to_seq` 的关系**（D-55 的确认，广播要求）：`consumed_up_to_seq` 只跟踪 `user.message`，`booking.*` 从来不影响它（§6.4）。D-55 决定的是"投影到哪里"，是 projector 的职责；gateway 只负责按 seq 落库。两者**不冲突**，gateway 这边不需要改动。
- 出票结果只由**系统**告诉用户（卡片），不经过 LLM 的文字。票号、航段和价格全部来自数据库。
- v0.3 请求体里的 `{ sessionId }` 已经去掉（O-3）：报价本来就绑定在一个会话上（`quotes.session_id`），由 booking 自己读出来。

失败语义：
| 情况 | 处理 |
|---|---|
| 浏览器重复点击，或者网络重试 | `tickets.quote_id UNIQUE` 保证只出一张票；重复请求返回 200 `alreadyBooked`。前端在请求进行中禁用按钮 |
| 并发确认（比如 20 个请求同时到达） | 只有一个 INSERT 能成功，其余都返回 `alreadyBooked`。**T07 必须有这个并发测试** |
| gateway → booking 超时，或者 booking 返回 5xx | 返回 503 `BOOKING_UNAVAILABLE`，**不写** `booking.failed`。浏览器提示"确认中"，然后轮询 `GET /quotes/:quoteId`，看 `booking.status`；重试是安全的 |
| booking 已经提交，但 gateway 没写成 `booking.confirmed`（超时返回了 503，或者 gateway 崩溃） | 机票已经出了，但还没有事件。两条路径补齐：① 用户重试，得到 `alreadyBooked`，gateway 补写事件；② **sweeper 每 15 秒对账一次**（§7.4，I-9）。两条路径用同一个幂等键 `booking:{quoteId}`，所以事件只会写一次。最坏情况下，事件最多晚 15 秒落库 |
| 报价没有出示过（比如有人直接拿 quoteId 调接口） | 409，不出票；写一个 `booking.failed`，前端在报价卡上显示错误 |
| 报价不存在，或者不属于当前用户 | 404，什么都不写 |
| **任何失败都不按门铃**（D-51 ✅，和 D-39 一致） | 前端在报价卡上显示本地化的错误；agent 在用户下一次发消息时，通过投影看到 `booking.failed` |

`GET /quotes/:quoteId` **不**负责补写事件（验收报告 I-9 的第二个建议，**不采纳**）：让 GET 请求产生写入副作用，会让缓存、重试和审计都更难理解；sweeper 的 15 秒对账已经足够。

### 5.3 hands token（让 hands 知道"这是谁"，但身份不经过 LLM）
- **签发**：harness 调用 `POST /internal/v1/sessions/:id/hands-token`，带上 `X-Lease-Fence`。gateway 依次检查：
  1. fence（和 emitEvent 第 4 步用同一个 Lua 脚本）；
  2. **会话处于活动状态**：`last_user_seq > consumed_up_to_seq`（有未消费的输入），或者 `open_run_id IS NOT NULL`（有未结束的运行）。否则返回 `409 SESSION_INACTIVE`（I-10 的可选加固，已采纳）。
  然后查出会话的 `user_id`，签发 token。
- **格式**（S-2）：JWS compact serialization。
  - header：`{ "alg": "EdDSA", "typ": "JWT", "kid": "<公钥指纹的前 8 位>" }`；
  - claims：`{ "iss": "gateway", "aud": "hands", "sid": "<uuid>", "uid": "<uuid>", "iat": <秒>, "exp": iat + 300, "jti": "<随机>" }`；
  - 验证时允许 30 秒的时钟偏差。`kid` 是为以后轮换密钥准备的：hands 可以同时信任新旧两把公钥。
  - 实现用 Node 的 `crypto.sign(null, data, ed25519Key)`，不引入 JWT 库。header 和 claims 都很小，手写的编码和解码函数放在 `@fb/contracts/server`，并配上测试向量。
- **使用**：harness 把它放进 `Authorization` 头调用 hands。harness 拿不到私钥，所以**伪造不了**其他用户的 token。
  - 注意：token 是**签名，不是加密**。harness 能读出里面的 `uid`。"session API 不返回 userId"只是约定，不是隔离。真正有保证的是：uid 不会进入 LLM 的上下文（A-02 保证），工具参数里也没有身份字段（H-04）。
- **校验**：hands 用公钥验证签名、`aud`、`exp`，再用 `fb_hands` 的只读列查 `sessions(id, user_id)`，确认 sid 和 uid 匹配。之后所有工具都使用 token 里的 uid 和 sid。
- 被攻破的 harness 用它能做什么，见 §2.7。

### 5.4 booking API（booking:8083，只给 gateway 用）
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /internal/v1/bookings` | `{ quoteId, userId, requestId }` | 201 `{ ticket: TicketView }`；200 `{ ticket, alreadyBooked: true }`；错误一律用 `ApiError` 信封（§4.1）：404 `QUOTE_NOT_FOUND`、409 `QUOTE_NOT_OFFERED`、400 `VALIDATION_FAILED`、401 `SERVICE_AUTH_INVALID`、503 `SERVICE_UNAVAILABLE` |
| `GET /healthz`、`GET /readyz` | — | 200 |

- 鉴权：`Bearer <booking_service_token>`，并且来源地址必须是 gateway（`172.30.3.20/32`）。booking 只接入 `bk` 和 `db_booking` 两个网络。
- gateway 怎么把这些结果映射成公共 API 的响应，见 §4.6。

### 5.5 hands API（hands:8082）
- 路径是 `POST /internal/execute`（A-02 §5.1），只绑定在 `172.30.2.30:8082`，只接受来自 harness 地址段的连接。请求 / 响应 / 错误信封由 A-02 §5 定。
- **A-01 需要 A-02 在信封里加一个字段**（I-6，C-11）：`inputSeq: number`。harness 从本次运行的 `inputSeqs` 里取最后一条 `user.message` 的 seq 填进去。
  - `save_preference` / `forget_preference` 用它写 `user_memories.source_seq`（对应 A-02 的 `sourceEventSeq`）；
  - hands 校验 `1 ≤ inputSeq ≤ sessions.last_user_seq`，不满足返回 `VALIDATION_FAILED`。
- **幂等**（存储在 `app.tool_calls`，§3.2）：key 是 `(session_id, run_id, tool_call_id)`（S-15），`input_sha256 = sha256(canonicalJson(input))`（I-5）。
  - 用规范化的 JSON 计算哈希，是因为崩溃后重放时，harness 用的是**从日志里读回来的 args**；而 jsonb 会改变键的顺序，直接 `JSON.stringify` 得到的字符串会和第一次不一样，D-47 的重放就会误判成 `IDEMPOTENCY_CONFLICT`。
  - T08 的实现步骤（tool_calls 只能插入，所以不能"先占位、后补 response"）：
    1. 先查 key。有记录：`input_sha256` 相同就直接返回已有的 response；不同就返回 `IDEMPOTENCY_CONFLICT`。
    2. 没有记录：在**一个事务**里执行工具的副作用（比如写 quotes、quote_offers），**最后一步**才 INSERT tool_calls。
    3. 提交时遇到主键冲突（另一个相同的并发调用先提交了）：回滚整个事务，回到第 1 步。
  - 这样，同一个 key 的并发调用只有一次能提交，副作用也只发生一次。T08 必须有这个并发测试，以及一个"键序往返"测试：同一个 input 打乱键的顺序后，哈希必须相同。
- **同一个会话里，不同 toolCallId 的调用可以并发执行**（D-44 默认并行；S-9，C-13）。hands **不做**会话级的串行化，每次调用各用各的事务。有副作用的工具（`offer_booking`、`save_preference`、`forget_preference`）由 harness 标成 `sequential`（D-44），hands 不依赖这一点来保证正确性。
- 其他要求：
  - 请求体上限 16 KB；
  - 每次调用都打一条日志：工具名、耗时、结果码，**不记录参数原文**；
  - 带 `traceparent` 和 `X-Trace-Id`（X-9）；
  - 未知的工具名返回一个确定的错误码；
  - `sys.*` 调用（A-02 §5.2）和工具调用走同一个入口，鉴权方式也一样。

---

## 6. 事件信封、事件类型和会话状态

### 6.1 内部信封（放进 `@fb/contracts/server`）
```ts
interface EventEnvelope<T extends EventType = EventType> {
  id: string;            // uuid
  sessionId: string;
  seq: number;           // 每个会话从 1 开始，连续无空洞
  type: T;
  actor: 'user' | 'agent' | 'system';
  ts: string;            // 服务端分配
  traceId: string;
  idempotencyKey: string;
  schemaVersion: 1;
  payload: PayloadOf<T>;
}
interface EphemeralEnvelope<T extends EphemeralType = EphemeralType> {
  sessionId: string; type: T; ts: string; traceId: string;
  payload: EphemeralPayloadOf<T>;          // v0.3 的 refSeq 已删除（O-5：没有任何使用方）
}
```
- **键顺序**（I-5，C-12）：`payload` 存在 jsonb 里，读回来时键的顺序会变。所以：
  - 对 payload 取哈希、做比较时，一律使用 `canonicalJson`；
  - **D-54 ✅**：`agent.message.payload.messageJson: string` 保存 pi 消息的**原样 JSON 字符串**（等于 `JSON.stringify(piMessage)`，A-02 v0.4 §2.3）。它是 jsonb 里的一个字符串值，字节内容不会被改变，用于保证"重放请求和第一次请求逐字节一致"。gateway 把它当作**不透明的字符串**：只计入大小限制，不解析；公共视图里一定会去掉它（§4.5）。
  - 哈希和幂等比较仍然一律用 `canonicalJson`（D-54 不改变这一点）。

### 6.2 持久化规则
| 规则 | 理由 |
|---|---|
| **凡是会影响状态、历史回放或 LLM 上下文的事件，都要落库** | session 日志是唯一的事实来源（H-05 / H-06） |
| LLM 的流式增量、工具状态、打字状态、心跳**不落库**，只走 Redis pubsub → SSE | 量大，价值低；最终的完整消息会作为单独的事件落库（A-02） |
| 事件只能由 gateway 写入数据库 | 数据归属唯一（§3.3） |
| actor 由 gateway 根据**调用来源**决定：公共 API 写入的是 `user`，session API（harness）写入的是 `agent`，gateway 自己写的是 `system`。**写入方不能自己指定** | 防止 harness 冒充用户或系统 |
| 每个事件都有 `idempotencyKey` | 所有写入都可以安全重试 |

### 6.3 A-01 负责的事件类型
| type | actor | 写入方 | 内部 payload | idempotencyKey | 前端怎么渲染 |
|---|---|---|---|---|---|
| `user.message` | user | gateway（公共 API） | `{ text, clientMessageId }`（text 已转义，§4.3） | `user:{clientMessageId}` | 用户气泡，纯文本 |
| `quote.offered` | agent | harness（经 session API，§5.1 的校验） | `{ runId, quoteId, toolCallId }`（A-02 §2.1），**没有任何数字** | `offer:{toolCallId}`（A-02 §3.7） | **报价卡**（§9.3），数据从 `GET /quotes/:quoteId` 取 |
| `booking.confirmed` | system | gateway | `{ quoteId, ticketId, ticketNo, summary: TicketSummary }`（§4.5） | `booking:{quoteId}` | 报价卡切换成"已出票"，下方显示**系统出票卡片**（§9.3.1）。**不唤醒 agent**（D-39） |
| `booking.failed` | system | gateway | `{ quoteId, code: ErrorCode }` | `booking-failed:{quoteId}:{traceId}` | 报价卡上显示本地化的错误。**不唤醒 agent**（D-51） |

- v0.3 的 `session.created` 已删除（O-8；C-16 也随之消失）。
- `session.status` 不是事件：显示状态通过 SSE 的 `status` 帧推送（§4.4）。
- agent 侧的事件由 A-02 §2 定义（含 D-52 ✅ 的 `agent.context_compacted`：只有 harness 能写，必须带 fence，idempotencyKey 是 `compact:{compactionId}`，A-02 §3.7）。它们的公共视图见 §4.5。
- `agent.message` 的模板消息标记统一放在 **`payload.meta.template`**（C-9；A-02 §2.1 需要把 `meta` 加进 payload 的定义）。

### 6.4 消费跟踪和显示状态（B-2、B-3）
gateway 在写**每一个**事件的同一个事务里（§5.1 第 7 步、§4.3），按下面的规则更新 `sessions` 的跟踪列：

| 写入的事件 | 更新的列 |
|---|---|
| `user.message` | `last_user_seq = seq`，`last_user_at = now()`；如果写入之前没有未消费的输入（`oldest_unconsumed_at IS NULL`），就设 `oldest_unconsumed_at = now()` |
| `agent.run_started` | `consumed_up_to_seq = GREATEST(consumed_up_to_seq, payload.consumedUpToSeq)`（A-02 v0.4 §2.1：`consumedUpToSeq = max(inputSeqs)`，gateway 在 §5.1 第 1 步校验过）；`open_run_id = runId`；然后重新计算 `oldest_unconsumed_at`：如果 `last_user_seq > consumed_up_to_seq`，取 `seq > consumed_up_to_seq` 的 user.message 里最早的 `ts`（走主键索引，只扫描会话尾部），否则设成 NULL |
| `agent.run_resumed` | `open_run_id = runId` |
| `agent.run_completed` | `open_run_id = NULL`，`last_run_outcome = 'completed'` |
| `agent.run_failed` | `open_run_id = NULL`，`last_run_outcome = 'failed'` |
| harness 写入的任何事件 | `last_agent_event_at = now()` |
| `agent.context_compacted` | 不改变消费跟踪列（压缩不消费任何输入，D-52）；只更新 `last_agent_event_at` |
| `booking.confirmed`、`booking.failed`、`quote.offered`、其他事件 | 不改变消费跟踪列（D-39、D-51、D-55） |

**"未消费的输入"的定义**：`pending := last_user_seq > consumed_up_to_seq`。
- 这依赖 A-02 §3.3 的一条性质：每次新开运行时，`inputSeqs` 包含**全部** pending 的 `user.message`，并且是按 seq 顺序的。所以只看最大值就够了。如果 A-02 以后改成"只消费一部分"，这里要改成按集合计算。这一条作为接缝要求写进 §16.3。
- `booking.*` 不是输入（A-02 §2.4），从来不影响 `consumed_up_to_seq`。D-55 只决定 projector 把它们投影到哪里，和这里的语义不冲突（§5.2）。
- 为什么用 `oldest_unconsumed_at` 而不是 `last_user_at` 来判断"等了多久"：如果用户每隔几秒就发一条消息，`last_user_at` 会被不断刷新，sweeper 的 10 秒条件就永远不会满足。A-02 v0.4 §3.1 W1 的原文也是"**最早**那条未消费消息已经超过 10s"。
- 被一次运行"消费"，指的是它的 seq 出现在某次 `agent.run_started.inputSeqs` 里，**不管那次运行最后成功还是失败**。运行失败时，A-02 会写一条系统模板消息（A-02 §12），用户能看到结果。所以失败也算"被处理了"。

**显示状态**（`sessions.status`，只用于显示，**任何逻辑都不能读它来做判断**）：
| 条件（按顺序，命中第一条就停） | status |
|---|---|
| `open_run_id IS NOT NULL` | `running` |
| `pending` | `queued` |
| `last_run_outcome = 'failed'` | `error` |
| 其他 | `idle` |

- 和 v0.3 的区别：
  - `booking.failed` 不再让状态变成 `queued`（B-2，D-51）；
  - 运行结束时如果还有未消费的输入，状态是 `queued`，而不是 `idle`（B-3）；
  - **sweeper 不再看 status**（§7.4）。

---

## 7. Redis 用途和 key 规划

### 7.1 key 和频道
| key / 频道 | 类型 | 写入方 | 读取方 | TTL | 用途 |
|---|---|---|---|---|---|
| `auth:sess:{sid}` | hash | gateway | gateway | 7 天，滑动续期 | 登录会话 |
| `bull:harness-wake:*` | BullMQ 队列 `harness-wake` | gateway（写入 user.message 后、sweeper） | harness（worker） | `removeOnComplete: true`、`removeOnFail: true`（A-02 v0.4 §3.1） | 门铃（D-04、D-60） |
| `lease:session:{sid}` | string | harness | harness | 30s，续租 | 租约（A-02 §3.2） |
| `lease:fence:{sid}` | 整数 | harness（INCR）；**gateway（只在 Redis 数据丢失后重置，§5.1 第 4 步）** | gateway、harness | 不过期 | fencing |
| `sse:session:{sid}` | pubsub 频道 | gateway：`{kind:'evt',seq}`、`{kind:'status',status}`；harness：`{kind:'eph', event, fence}` | gateway（SSE 扇出，按 fence 过滤，§4.4） | — | 实时推送 |
| `sse:logout` | pubsub 频道 | gateway | gateway | — | 退出登录时，通知所有 gateway 副本关闭这个 sid 的 SSE 连接（S-4） |
| `sweeper:lock` | string | gateway | gateway | PX 14000 | 多个 gateway 副本时，保证同一时间只有一个 sweeper 在运行（§7.4） |

### 7.2 ACL（I-3、I-10）
```
user default off
user gateway on #<sha256> ~auth:* ~bull:harness-wake:* ~lease:fence:* ~sweeper:lock &sse:*
             +@read +@write +@pubsub +@scripting +@transaction +@connection -@dangerous
user harness on #<sha256> ~bull:harness-wake:* ~lease:* &sse:*
             +@read +@write +@pubsub +@scripting +@transaction +@connection +@blocking -@dangerous
```
- gateway 对 `lease:fence:*` 有**读写**权限（v0.3 是只读 `%R~`，没法执行 D-34 要求的重置，I-3）。它对 `lease:session:*` 没有任何权限，所以不能伪造租约。
- BullMQ 需要哪些具体命令（比如 `EVALSHA`、`BZPOPMIN`、`XADD` 等）由 T00 用实际的 BullMQ 版本验证，然后把上面的命令类别收窄成具体的命令清单。
- hands、booking、caddy、migrate **没有 Redis 账号**。

**如实说明 harness 持有 `lease:*` 写权限意味着什么**（I-10）：
- 租约和 fencing 防的是**诚实但过时**的 worker：GC 停顿、网络分区之后醒过来的旧进程。
- 它们**防不住**一个被攻破的 harness：它可以自己 INCR fence、自己 SET 租约，然后为任意活动中的会话写事件、申请 hands token（§2.7）。
- 要防住这种情况，需要把"拿锁"也放到 gateway 里（D-34 方案 B）。这不在 v1 的范围内。

### 7.3 门铃（D-60 ✅，和 A-02 v0.4 §3.1 一致）
任务只是门铃，不携带"要处理什么"（A-02 §3.1）：
```ts
// queue: 'harness-wake'；attempts: 3，指数退避；removeOnComplete: true；removeOnFail: true
interface WakeJob { sessionId: string; traceparent: string }
```
**每条输入一个门铃**，jobId 不会被正在执行的旧任务去重吃掉：
| 谁按门铃 | jobId | 说明 |
|---|---|---|
| gateway，写入 `user.message` 之后 | `wake-{sid}-{seq}` | 每条新消息对应一个新任务。只有"同一条消息的重试"才会被去重 |
| gateway 的 sweeper（§7.4） | `wake-{sid}-scan-{floor(epochMs / 15000)}` | 每个扫描周期一个新 id，同一个周期里只补一次 |
| harness | **不按门铃**。A-02 v0.4 §3.1 第 2 条改成"在同一个任务里循环，释放租约后再检查一次，并自己重新抢锁"，所以 v0.4 的 A2-3 已经作废 | — |

- 用 `-` 而不是 `:`，因为 BullMQ 的自定义 jobId 可能不允许包含 `:`（X-5，留给 T06 / T09 验证）。
- **多余的门铃是无害的**：拿不到租约、或者没有待处理工作的 worker 会立刻结束（A-02 §3.3）。所以不需要为了减少任务数量去做去重。
- 不变量**不依赖** BullMQ 的去重语义：即使所有门铃都丢了，sweeper 也会在有限时间内补上（§7.4）。

### 7.4 sweeper（gateway 里唯一的后台任务，O-6）
v0.3 里的三个后台任务（启动时对账、每 60 秒恢复扫描、Redis 数据丢失后重置 fence）合并成一个，**每 15 秒运行一次**：
- fence 的重置已经由 emit 时的 Lua 脚本按需处理（§5.1 第 4 步），不再需要单独的任务；
- 运行前先 `SET sweeper:lock <id> NX PX 14000`，抢不到就跳过这一轮（只在多副本时才有意义）。

**任务 1：未消费输入的门铃恢复**（阈值和 A-02 v0.4 §3.1 的 W1 / W2 一致：10 秒 / 45 秒 / 每 15 秒扫描一次；C-3、I-11）：
```sql
SELECT id FROM app.sessions
WHERE (last_user_seq > consumed_up_to_seq AND open_run_id IS NULL
       AND oldest_unconsumed_at < now() - interval '10 seconds')         -- W1：最早那条未消费的输入已经等了 10 秒
   OR (open_run_id IS NOT NULL
       AND COALESCE(last_agent_event_at, updated_at) < now() - interval '45 seconds')   -- W2：有未结束的运行，但 harness 45 秒没有写过事件
LIMIT 200;
```
对查出来的每个会话，用 §7.3 的 sweeper jobId 按一次门铃。
- 45 秒 = 租约 TTL 30 秒 + 续租间隔 10 秒 + 5 秒余量，保证这时旧 worker 的租约一定已经过期，新 worker 拿得到锁（A-02 X-11 的推导）。
- 一次长时间的 LLM 请求（最长 60 秒加上重试）期间，可能会超过 45 秒都没有 emit。这时只会多按一次无害的门铃。
- 如果同一个会话连续 20 轮（5 分钟）都被扫出来，记一条 error 日志，方便发现 harness 整体不可用的情况。门铃照常按，不会停。

**任务 2：出票事件对账**（I-9）：
```sql
SELECT t.* FROM app.tickets t
WHERE t.booked_at < now() - interval '5 seconds'
  AND NOT EXISTS (SELECT 1 FROM app.events e
                  WHERE e.session_id = t.session_id AND e.idempotency_key = 'booking:' || t.quote_id)
LIMIT 100;
```
对每张票，以系统身份补写 `booking.confirmed`（幂等键相同，所以就算和用户重试撞在一起，也只会写一次）。补写**不按门铃**（D-39）。

**不变量的论证**（B-3，契约不变量；"有限时间"指的是在 harness 和 Redis 都能正常工作的前提下）：
1. 每条 `user.message` 落库时，同一个事务里会更新 `last_user_seq` 和 `last_user_at`。所以"未消费"这个事实**和消息本身同时持久化**，不会丢。
2. 如果没有任何运行在 10 秒内消费它，任务 1 的第一个条件成立，sweeper 在接下来的 15 秒内按门铃。门铃的 jobId 是新的，不会被去重吃掉。
3. 如果有一次运行正在进行，但它所在的 worker 已经死了：45 秒后任务 1 的第二个条件成立，门铃会唤醒一个新 worker。这时旧租约（30 秒）已经过期，新 worker 拿得到锁，按 A-02 §3.6 恢复那次运行。运行结束时 `open_run_id` 被清空；如果还有未消费的输入，就会回到第 2 点。
4. 如果运行一直正常：A-02 v0.4 §3.1 第 2 条的"同一个任务里循环、释放后再检查并重新抢锁"会立刻处理新输入；就算这一步漏掉了，第 2 点也会在 25 秒内补上。
5. 所以，在 harness 能正常工作的前提下，每条 `user.message` 最晚在 **约 25 秒**（无运行）或 **约 60 秒**（worker 崩溃）之后进入一次运行。harness 整体不可用时，sweeper 会每 15 秒持续按门铃，直到它恢复，并且会记 error 日志。
6. Redis 数据丢失时：门铃、租约都没了。但第 1 点的持久化事实在 Postgres 里，sweeper 照常补门铃；fence 由 §5.1 第 4 步的 Lua 脚本处理。

T06 / T09 / T15 的测试（I-14 的 H-06 部分）：
- **运行中途发消息**：在一次运行进行中发送第二条消息，断言它在一个有限的时间内（比如 60 秒）被下一次运行的 `inputSeqs` 包含；
- 停掉 BullMQ（或者清空队列）以后，断言 sweeper 能在 25 秒内补上门铃；
- 在运行中途杀掉 harness，断言 60 秒内另一个 worker 恢复了这次运行；
- `FLUSHALL` Redis 以后，断言旧 fence 的写入被拒绝、新 worker 的写入被接受，未消费的输入最终被处理；
- 制造"booking 已提交但 `booking.confirmed` 没写"的情况，断言 sweeper 在 20 秒内补上了事件。

---

## 8. 可观测性（D-11：只预留 OTel 接口）
- **trace 头**（X-9，父会话已裁定）：所有内部 HTTP 请求都带 W3C 的 **`traceparent`**，同时带上 `X-Trace-Id`（等于 traceparent 里的 32 位 trace-id）。两者不一致时以 traceparent 为准，并记一条 warn 日志。
  - gateway 收到浏览器请求时，如果没有 `traceparent` 就生成一个；
  - 透传到门铃任务（`WakeJob.traceparent`），再到 harness 发出的所有内部 HTTP 请求，再到 hands、booking；
  - 每个事件都记录 `trace_id`。这样一次对话能从浏览器一路串到工具调用；
  - 公共 API 的响应头里只带 `X-Trace-Id`（§4.1），方便用户报错时提供；
  - `@fb/platform/http` 的客户端自动加上这两个头，各服务不要自己拼。
- **日志**：pino 输出 JSON。固定字段：`ts, level, service, traceId, spanId, sessionId, userId, route, status, durationMs, msg`。
- **永远不记录**：cookie、各类 token、API key、Authorization 头、`SecretProvider` 返回的任何值、用户消息原文、LLM 文本原文。需要的话只记录长度和哈希；对话内容本来就在事件日志里。pino 配置 `redact`，并在 T06 的测试里验证。
- **OTel 预留**：`@fb/platform/trace` 导出 `Tracer` 和 `Span` 接口，默认是空实现。设置了 `OTEL_EXPORTER_OTLP_ENDPOINT` 时，换成 OTel SDK 的实现（这是将来的工作，现在只保证接口和 traceparent 透传是对的）。harness 内部怎么切 span 由 A-02 补充。
- **健康检查**：每个服务有 `/healthz`（进程活着）和 `/readyz`（依赖可用：数据库、Redis；hands 还要确认 db 哈希校验已通过）。compose 的 `healthcheck` 用 `/readyz`。sweeper 每一轮都输出一条 info 日志，内容是扫出的会话数和补写的事件数。

---

## 9. 前端结构（apps/web）

### 9.1 技术栈
- React 18 + Vite + TypeScript（P-01 §3.4）。
- 推荐的库：react-router；TanStack Query（管理服务端状态）；i18next（中英双语）；react-markdown（**不开启 raw HTML**，D-25）；MSW（mock）。全部是 MIT 许可，精确锁版本。
- 这些具体的库还**没有**单独的 D-xx 决策，按 H-09 在依赖冻结阶段由父会话统一确认。

### 9.2 路由和页面
| 路由 | 页面 | 对应要求 |
|---|---|---|
| `/login` | 输入用户名 | D-08 |
| `/chat` | 新建会话后跳转到 `/chat/:id` | G-01 |
| `/chat/:sessionId` | 聊天界面：消息流、输入框、状态指示（v1 不做停止按钮，D-33） | G-01 / G-06 / G-07 |
| `/history` | 会话列表（标题、时间、状态），点击进入 `/chat/:id` 回放或继续对话 | G-09 |
| `/tickets`、`/tickets/:ticketId` | 我的机票 | G-08 |
| `/profile` | 画像：偏好列表，可以单条删除或全部清空 | D-13 |
| 顶栏 | 语言切换（zh / en，写入 `PATCH /me`）、退出登录 | D-13 |

### 9.3 报价卡（QuoteCard）：H-01 和 D-06 在界面上的落点
- **数据来源**：只用 `GET /quotes/:quoteId` 返回的 `QuoteView`。卡片**不读取 LLM 文本里的任何数字**，`quote.offered` 事件里也没有数字。
- **必须显示**（G-06 / 题目第 7 条），数字一律用 `quote.display` 里的字符串：
  - 出发地 → 每一个换乘城市（`quote.transferCities`）→ 目的地，城市名用 city_name 原文；
  - 每段航程的起止城市和距离（`display.legs[i]`，km，2 位小数）；
  - 换乘城市要明确标注"在 X 换乘"；直飞时显示"直飞"；
  - 总距离（`display.totalDistanceKm`）；
  - 价格（`display.priceUsd`，USD）；
  - 计价说明："价格 = 总距离 × 0.13 USD/km；总距离按未舍入的各段距离相加，因此可能和各段展示值之和相差 0.01"（A-02 R-6 / §7.6）；
  - "确认下单"按钮。
- **按钮状态**：`available`（可以点）、`pending`（请求中，禁止重复点击）、`booked`（显示票号，不能再点）、`error`（显示本地化的错误，可以重试）。
  - 卡片收到同一个报价的 `booking.confirmed` 事件（或者确认请求直接返回了 ticket）后，切换到 `booked`；
  - 收到 503 时显示"确认中"，然后每 3 秒轮询一次 `GET /quotes/:quoteId`，最多 20 次，直到 `booking.status` 变成 `booked`，或者用户手动重试。
- 同一个会话里的旧报价卡仍然可以点（D-10 报价不过期），但每个报价只能成功出一次票。
- **点击之前不弹二次确认框**：卡片本身就是确认步骤，一次点击就提交（D-06）。
- 卡片底部有一行固定的小字："只有点击此按钮才会出票"（中英双语）。
- 确认请求**不带请求体，也不带 `Content-Type`**（§4.2）。

### 9.3.1 系统出票卡片（TicketCard）：D-39 / D-51 出票后 agent 不说话
因为出票后 agent 不会发言，出票结果**完全由这张卡片告诉用户**。所以它必须能独立说明结果：
- **数据来源**：确认请求返回的 `TicketView`；刷新页面或者回放历史时，按 `booking.confirmed` 的 `ticketId` 调用 `GET /tickets/:ticketId`。
- **必须显示**：
  - "已出票"状态和票号 `ticketNo`；
  - 出发地 → 换乘城市 → 目的地，以及每一段航程；
  - 总距离和成交价（来自 `itinerary.display`，和报价卡完全一致）；
  - 出票时间；
  - 一个"查看我的机票"链接，指向 `/tickets/:ticketId`。这是站内路由，和 D-25 的"LLM 文本里的链接不能点"不冲突。
- **视觉上明确标成"系统消息"**，和 agent 的气泡区分开。
- 文案中英双语，跟随界面语言。
- 出票**失败**时（`booking.failed`，D-51）：同样由系统在报价卡上显示错误（文案按 `code` 查 i18n 表），agent 也不会发言。

### 9.4 消息渲染和 XSS 防护
前端只处理 `PublicEvent`（§4.5），拿不到内部的 payload。

| 公共事件 | 怎么渲染 |
|---|---|
| `user.message` | 用户气泡，纯文本 |
| `agent.message`，`kind = 'reply'` | agent 气泡；用 react-markdown 渲染，**禁用 raw HTML，不显示图片；链接显示成纯文本，不能点击**（D-25）。带 `template` 的消息（系统模板消息）用一样的气泡样式。**只有最终回复会显示成气泡** |
| `agent.message`，`kind = 'process'` | **不显示成气泡**。作为一个"步骤"放进这次运行的过程区（§9.4.1），显示 `processText`，**纯文本** |
| `agent.message`（toolResult 形式：有 `toolCallId`） | 不显示 |
| `hidden` | 不显示（只占用一个 seq）。system 消息、压缩事件都是这个类型 |
| `agent.guard_violation`（C-6、I-12；**C-7 父会话已裁定**） | 按 `messageKey` 处理，`action` 只有两种（A-02 v0.4 §2.1）：<br>• `regenerate`：被拦截的消息**从不落库**，前端只需清掉这个 messageKey 还在显示的流式文字（如果有）；随后会有一条新的、通过守卫的消息落库；<br>• `replaced`：被拒绝的消息**从不落库**，只另写一条模板消息（C-7 裁定）。前端同样只清掉流式文字，模板消息按普通的 `agent.message` 显示。<br>两种情况都**不需要**隐藏任何已经落库的消息 |
| `agent.run_failed` | 不单独显示，后面紧跟的系统模板消息会解释原因 |
| `agent.run_started` / `run_resumed` / `run_completed` | 不显示 |
| `quote.offered` | 报价卡（§9.3） |
| `booking.confirmed` | 对应的报价卡切换成"已出票"，下方显示系统出票卡片（§9.3.1） |
| `booking.failed` | 报价卡上显示本地化的错误，按钮恢复成可以重试 |
| 临时 `agent.delta` / `agent.reasoning_delta` / `agent.tool_status` | 都显示在这次运行的**过程区**里（§9.4.1） |
| SSE 的 `status` 帧（`running`） | 过程区还没有任何内容时，显示正在输入的动画（替代 A-02 已删除的 `agent.status`） |

### 9.4.1 过程区（ReAct 中间过程，D-63 / D-64 🔁）
用户原话："中间 react 之类的过程都需要短暂显示中间reasoning文本"。

**位置和样式**
- 每一次运行（按 `runId` 分组）在消息流里有**一个**过程区，位于这次运行的最终回复上方。
- 弱化样式：小一号字、浅灰色、左侧一条竖线、背景色和气泡不同，视觉上明确不是 agent 的回复。
- 过程区顶部有一行固定的标题和提示（i18n key 见下表），**任何时候都显示，折叠后也显示**：
  - 中文："思考过程 · 中间过程，不作为报价依据"
  - 英文："Thinking process · Intermediate steps, not a basis for any quote"
- 过程区里**不显示**报价卡、出票卡片和"确认下单"按钮，它们仍然只出现在消息流的正常位置。**报价卡是数字唯一的权威来源**（H-01）。

**内容**（一律**纯文本**：不用 markdown，不识别链接，不显示图片，换行原样保留，长文本自动折行）
| 来源 | 显示成 | 什么时候出现 |
|---|---|---|
| `agent.reasoning_delta` | 一段"推理"文字（再弱一级的样式，比如斜体） | 运行期间实时追加；**只存在于内存里** |
| `agent.delta` | 一段"正在输出"的文字，按 messageKey 分组 | 运行期间实时追加。落库以后：如果是最终回复，从过程区移到气泡（以落库版本为准）；如果是中间步骤，换成落库的 `processText` |
| `agent.message`（`kind='process'`） | 一个步骤：`processText` | 落库后。**刷新页面、断线重连、回放历史时，过程区只由这类落库内容构成** |
| `agent.tool_status` | 一行步骤提示，比如"正在查询航线…"（工具名到文案的映射放在 i18n 里） | 运行期间实时 |
| 落库的 toolResult（`agent.message`，有 `toolCallId`） | 一行"✓ 已查询航线"或"✗ 查询航线失败"（只用 `toolName` 对应的文案和 `isError`） | 落库后；回放时也显示 |

**打码**：过程区里的数字由 harness 在推送前和落库前打码（A2-17）。占位符是 `@fb/contracts/web` 里的常量 `MASK_TOKEN`（建议 `•••`）。前端遇到它就按普通文字显示，并加一个 tooltip："中间过程里的数字已隐藏，请以报价卡为准"（i18n）。前端**自己不做**任何打码或数字识别。

**折叠时机**
1. 运行进行中：过程区**展开**，实时追加内容。
2. 下面任何一件事发生时，过程区**自动折叠**成一行"思考过程（N 步）· 中间过程，不作为报价依据 ▸"，用户可以点击展开：
   - 这次运行的最终回复落库（`kind='reply'` 的 `agent.message`）；
   - 收到这次运行的 `agent.run_completed` 或 `agent.run_failed`。
3. 折叠的同时，**丢弃**内存里这次运行的临时内容（推理片段、流式文字、工具状态）。展开后只能看到落库的步骤（`processText` 和 toolResult 那一行）。所以推理文本只是"短暂显示"，折叠后就不会再出现。
4. N = 这次运行落库的 `kind='process'` 消息数量。N 为 0 时（这次运行没有调用工具，只有推理），折叠后整行都不显示。
5. 历史回放、刷新页面、断线重连：已经结束的运行一律以**折叠**状态出现；还在进行中的运行，过程区展开，但**只显示已经落库的步骤**，之后接着显示新的实时内容。**临时事件不重放**（它们本来就不落库，§4.4）。

**i18n key**（`apps/web/src/i18n/{zh,en}.json`，T11 的测试检查两份文件的 key 一致）
| key | 中文 | 英文 |
|---|---|---|
| `process.title` | 思考过程 | Thinking process |
| `process.disclaimer` | 中间过程，不作为报价依据 | Intermediate steps, not a basis for any quote |
| `process.collapsed` | 思考过程（{{n}} 步） | Thinking process ({{n}} steps) |
| `process.expand` / `process.collapse` | 展开 / 收起 | Show / Hide |
| `process.reasoning` | 推理 | Reasoning |
| `process.masked` | 中间过程里的数字已隐藏，请以报价卡为准 | Numbers in intermediate steps are hidden. Rely on the quote card |
| `process.tool.<toolName>.running` / `.done` / `.failed` | 正在查询航线… / 已查询航线 / 查询航线失败（每个工具一组） | Looking up routes… / Routes looked up / Route lookup failed |

**守卫撤回**：收到 `agent.delta { messageKey, reset: true }` 时，立刻清空过程区里这个 messageKey 的流式文字。

- 全站不使用 `dangerouslySetInnerHTML`（lint 规则）。
- **CSP**（由 Caddy 设置）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`。

### 9.5 SSE 客户端
- 每个打开的会话建立一个 EventSource，断线后由浏览器按 `retry: 3000` 自动重连，并带上 `Last-Event-ID`。
- 本地按 seq 存一个有序表，按 seq 去重；发现断档就用 REST 补齐。
- **流式内容**（D-64 🔁）：`agent.delta`、`agent.reasoning_delta`、`agent.tool_status` 都照常推送，放进对应运行的过程区（§9.4.1）。前端规则：
  - 按 `(runId, messageKey)` 拼接，只放在内存里；
  - 收到同一个 messageKey 的落库 `agent.message` 后，丢弃这段流式文字：`kind='reply'` → 在气泡里显示落库的 `text`；`kind='process'` → 在过程区里显示落库的 `processText`；
  - 收到 `agent.delta { messageKey, reset: true }`（A-02 §8.4，守卫撤回）时，**立刻清空**这个 messageKey 的流式文字；
  - **最终回复的气泡只显示落库后的文字**（已经通过守卫）。流式输出期间，最终回复的文字也先出现在过程区里，落库后才移到气泡。所以用户看到的"正式回复"永远是通过了数字守卫的版本（H-01）。
- **断线重连**：重连后只用 REST / SSE 补齐**落库**的事件，过程区只显示落库的步骤；断线期间错过的临时事件不补（§9.4.1 第 5 条）。
- 退出登录后，服务端会主动关闭连接（§4.2）；前端收到关闭后，跳转到登录页，不再重连。

### 9.6 中英双语（界面部分）
- 文案放在 `apps/web/src/i18n/{zh,en}.json`，key 用"命名空间.名字"的形式。T11 的测试检查两份文件的 key 集合完全一致。
- 语言优先级：用户设置（`users.locale`）> 浏览器语言 > 默认 zh。
- 新建会话时把当前界面语言传给 `POST /sessions`，作为对话语言的初始值。对话里实际用哪种语言由 A-02 的策略决定（D-43）。
- **城市名一律显示 `locations.db` 的 city_name 原文**（比如 São Paulo、San José），界面上不翻译、不去重音。中文别名的映射由 A-02 负责（D-37）。
- 数字和货币统一用 `quote.display` 里服务端格式化好的字符串，不使用 `Intl` 在本地再格式化。

### 9.7 mock（T11 开发时用）
用 MSW 模拟公共 API 和 SSE。mock 的数据由 `@fb/contracts/web` 的 schema 生成和校验，保证接上真实后端时字段对得上。mock 的数据集里**必须包含** `San Jose` 和 `San José` 两个城市，用来测试界面上不会把它们合并。

---

## 10. 部署（虚拟机，D-U4）
- **虚拟机**：Ubuntu 24.04 LTS，至少 2 vCPU / 4 GB 内存 / 20 GB 磁盘；安装 Docker Engine 和 compose 插件；防火墙（ufw）只开放 22、80、443。
- **目录**：`/opt/ocean-above`，从本地 git 仓库拷贝或克隆过来（D-14：不使用远程仓库）。镜像在虚拟机上本地构建（`docker compose build`），不使用镜像仓库。
- **机密**：`infra/vm/` 的初始化脚本负责：
  1. 生成随机的密码和 token（`openssl rand`），以及 Ed25519 密钥对（`openssl genpkey -algorithm ed25519`），写进 `/opt/ocean-above/infra/secrets/`；
  2. 从用户提供的 `.env` 里取出 DeepSeek key，写进 `deepseek_api_key`，然后删掉部署目录里的 `.env`；
  3. 设置权限：目录 `0700`、属主 root；文件 `0444`（§2.3）。
- **启动顺序**：postgres、redis（健康后）→ `migrate`（成功退出后）→ booking、hands → gateway → harness → caddy。
- **Caddy**：
  - 站点地址从环境变量 `SITE_ADDRESS` 读取；
  - **拿到域名之前**（D-23）：`SITE_ADDRESS=:80`，通过 `http://<虚拟机 IP>` 访问；gateway 设置 `PUBLIC_ORIGIN=http://<IP>`、`COOKIE_SECURE=false`；
  - **拿到域名之后**：`SITE_ADDRESS=book.example.com`，Caddy 自动申请证书；`PUBLIC_ORIGIN=https://...`、`COOKIE_SECURE=true`。只改配置，不改代码。
- **备份**（可选）：每天用 cron 执行一次 `pg_dump`，备份到虚拟机本地。
- **本地开发**（Windows）：`compose.dev.yml` 只启动 postgres 和 redis，各服务用 `pnpm dev` 在宿主机上运行，机密通过 `EnvSecretProvider` 读取（需要 `NODE_ENV=development` 和 `ALLOW_ENV_SECRETS=1`，§2.4）。
- **验证脚本** `scripts/verify-deploy.sh`（T14 / T15 实现；H-02、H-07 的测试都调用它）：
  1. **机密白名单**：对每个容器执行 `ls /run/secrets`，结果必须**完全等于** §2.3 矩阵里对应的那一列；
  2. **环境变量里没有机密**：对每个容器执行 `docker inspect` 和 `env`，不能出现名字匹配 `/(PASSWORD|SECRET|TOKEN|KEY)$/i` 的变量，也不能出现任何一个 secret 文件的内容；
  3. **网络可达性**：§2.2 矩阵里的每一格都要实际测一次。例如在 harness 里请求 `172.30.1.20:8080`、`booking:8083`、`postgres:5432`，都必须失败；在 hands 里请求 `172.30.2.20:8081`，必须返回 403 `FORBIDDEN_PEER`；在 gateway 里访问公网，必须失败；
  4. **pg_hba**：在 hands 里用 `fb_booking` 的身份登录（用一个测试密码），必须被拒绝；
  5. **挂载**：hands 里的 `locations.db` 必须是只读挂载，并且哈希等于 contracts 里的常量。

---

## 11. 失败语义汇总（前后端部分）
| 场景 | 行为 | 由哪个任务测试 |
|---|---|---|
| 同一个 clientMessageId 重复发送 | 返回 200 和原来的事件，不重复按门铃 | T06 |
| 同一个 clientMessageId，但 text 不同 | 409 `IDEMPOTENCY_CONFLICT` | T06 |
| harness 写事件时 fence 已经过时 | 409 `FENCE_STALE`，不写入；harness 立刻停止（A-02 §3.2） | T06 / T09 |
| Redis 数据丢失后，旧 worker 来写 | Lua 脚本重置 fence，返回 409；新 worker 可以正常写入（§5.1 第 4 步） | T06 |
| harness 写了不允许的事件类型，或者 `quote.offered` 没有对应的出示记录 | 403 `EVENT_TYPE_FORBIDDEN` / 400 `EVENT_INVALID` | T06 |
| harness 用相同的幂等键重复写事件 | 200，返回原来的 seq，`deduplicated: true` | T06 |
| 同一个会话并发写事件 | 行锁保证 seq 串行、连续 | T06 并发测试 |
| hands 收到相同 key 的并发调用 | 只有一次能提交，副作用只发生一次，另一次返回同样的结果 | T08 |
| 用户在运行中途发消息 | 消息落库，未消费的事实同时持久化；最晚由 sweeper 补门铃（§7.4） | T06 / T09 / T15 |
| 门铃丢失、BullMQ 去重吞掉门铃 | sweeper 每 15 秒按"未消费的输入"补门铃 | T06 / T15 |
| harness 在运行中途崩溃 | 45 秒后 sweeper 按门铃，新 worker 恢复运行（A-02 §3.6） | T09 / T15 |
| SSE 断线 | 浏览器重连，用 Last-Event-ID 续传；临时事件丢掉；断档用 REST 补齐 | T11 / T15 |
| gateway 重启 | 无状态，SSE 自动重连；sweeper 继续运行 | T15 |
| Redis 重启或数据丢失 | 用户需要重新登录；sweeper 补门铃；fence 由 Lua 脚本处理 | T15 |
| booking 不可用 | 503，用户可以安全重试；报价卡显示"确认中"并轮询 | T07 / T15 |
| booking 已提交，但事件没写成 | 用户重试或者 sweeper 对账补写（≤ 15 秒） | T06 / T07 |
| postgres 不可用 | `/readyz` 失败；公共 API 返回 503 `SERVICE_UNAVAILABLE`；Caddy 继续提供静态页面 | T15 |
| 请求过大或 schema 不合法 | 413 / 400 | T06 / T07 / T08 |

---

## 12. 安全边界（前后端部分；agent 的威胁模型在 A-02）
| 边界 | 措施 |
|---|---|
| 浏览器 → gateway | `HttpOnly` + `SameSite=Strict` 的会话 cookie；登录时轮换会话；CSRF 双重提交 + Origin 校验（§4.2）；CSP；`frame-ancestors 'none'`；不渲染 raw HTML，链接不可点击；公共事件视图按白名单裁剪（§4.5） |
| 用户之间的数据隔离 | 每条查询都带 `user_id = 当前用户`；访问别人的资源返回 404；记忆删除有复合外键；T06 / T07 / T08 都要有"用户 A 访问用户 B 的会话、报价、机票、记忆"的越权测试 |
| 内网里的端口 | 每个端口只绑定在一个网卡上，并检查来源地址（§2.2）；pg_hba 按角色限制来源（§2.2） |
| harness（会接触 LLM 输出的进程） | 没有数据库凭证，没有 booking 的凭证；网络上连不到 booking、postgres 和 gateway 的公共端口；只能通过 session API 按白名单写事件；租约 fencing |
| hands | 身份来自 gateway 签发的 token，不来自参数；数据库授权只到它需要的表和列；连不到 booking 和 gateway 的公共端口；不能出网 |
| booking | 只接受 gateway 的服务 token，并且只接受来自 gateway 地址的连接；一个事务里完成"报价归属 + 已出示 + 只能出一张票"的校验 |
| 数据库 | 每个服务一个角色，只给最小授权；只追加的表加触发器（防误操作）；运行时没有任何服务使用 owner 角色 |
| 机密 | 只以文件挂载，不进环境变量；每个容器只挂自己那一列（§2.3）；日志 redact |
| **已知弱点**（写进设计文档的"局限"） | ① 只填用户名就能登录，等于谁都可以冒充别人（D-08）；② 拿到域名之前走 HTTP（D-23）；③ **被攻破的 harness 进程**能读取所有会话、以任意活动会话的身份调用 hands、往别人的实时画面里塞假的流式文字，并且能像匿名互联网用户一样访问公网站点（§2.7）；④ fence 有毫秒级窗口（§5.1）；⑤ 用户输入里的伪标签会被转义，历史里显示成转义后的样子（§4.3）；⑥ 单机 Compose 的 secret 不加密，宿主机上的 root 可以读取（§2.3）；⑦ **过程区会短暂显示模型的中间文字和推理文本**（D-64）。这些文字没有经过数字守卫，只做了打码，所以可能包含措辞不当或者推理错误的内容；靠"中间过程，不作为报价依据"的提示、弱化的样式和自动折叠来降低误导。打码由 harness 负责，gateway 无法验证，一个被攻破的 harness 可以推送不打码的文字（同 ③） |

---

## 13. 硬规则 H-01 到 H-10：架构上怎么保证、用什么测试验证
所有"检查"都通过 **`pnpm check`**（本地运行）和 **pre-commit hook** 执行。D-14 只用本地 git，**没有 CI**（I-14）。

| 规则 | 在架构上怎么保证（A-01 部分） | 用什么测试验证（谁负责） |
|---|---|---|
| H-01 数字只来自确定性代码 | 报价由 hands 计算并落库，不可变；`quote.offered` 只带 `{runId, quoteId, toolCallId}`（gateway 严格校验，并核对出示记录）；报价卡只读 `GET /quotes/:quoteId`；展示字段用 contracts 里唯一的格式化函数生成；票价是报价的快照；`TicketSummary.display` 直接复制报价；**过程区**（D-64）的数字由 harness 打码，并且固定标注"中间过程，不作为报价依据"；**气泡只显示落库后、通过了守卫的最终回复**，流式文字只出现在过程区（§9.4.1、§9.5） | 契约测试：`quote.offered` 的 schema 里没有数字字段（T01）；过程区的 E2E 检查（§15 第 13 条，T15）；E2E：卡片和出票卡片上的数字等于 oracle 的结果（T15 + T04）；格式化函数的舍入边界测试（T01）。agent 文本里的数字守卫在 A-02 §8 |
| H-02 agent 没有任何下单途径 | 唯一入口是浏览器的 `POST /quotes/:quoteId/confirm`（cookie + CSRF + Origin）；booking 独立部署，只接受 gateway 的服务 token 和来源地址；harness 没有 booking 的凭证，网络上连不到 booking 和 gateway 的公共端口；harness 不能写 `booking.*` 事件；防点击劫持。**被攻破的 harness 的剩余能力见 §2.7** | `scripts/verify-deploy.sh` 第 1–3 步，**包括 harness / hands → gateway:8080 必须失败**（T14 / T15）；缺少 CSRF 或 Origin 时返回 403（T06）；harness 写 `booking.confirmed` 返回 403（T06）；没有出示过的报价确认返回 409（T07）；20 个并发确认只出一张票（T07）；工具清单里没有下单工具（A-02 / T09） |
| H-03 `locations.db` 只读 | 只以 `:ro` 方式挂载进 hands；用 `node:sqlite` 的只读模式打开（D-22）；启动时校验 sha256，不一致就拒绝启动（`/readyz` 失败） | `pnpm check` 和 pre-commit 校验仓库里的文件哈希（T00）；hands 启动测试：哈希不对时拒绝启动（T08）；`verify-deploy.sh` 第 5 步（T14） |
| H-04 身份只来自服务端会话 | 公共 API 的请求体里没有 userId；session API 不向 harness 返回 userId；hands 从签名 token 里拿身份；booking 收到的 userId 来自 gateway 解析的 cookie。注意：token 里的 uid 对 harness 可见，但不会进入 LLM 上下文（§5.3） | 契约测试：扫描所有公共请求 schema 和工具 schema，不能出现 `userId`、`user_id`、`username` 字段（T01）；越权测试（T06 / T07 / T08）；ajv 配置测试：请求里多带一个 `userId` 必须返回 400（T06） |
| H-05 事件只追加 | 运行时角色没有 UPDATE 和 DELETE 权限；有触发器防误操作；seq 连续。**真正的保证是"运行时没有任何服务使用 owner 角色"**（owner 可以禁用触发器，所以触发器只是防误操作，I-14） | 用每个运行时角色尝试 UPDATE、DELETE、TRUNCATE，都必须失败（T05）；seq 连续性检查（T06）；`verify-deploy.sh` 第 1 步：`pg_owner_password` 只出现在 migrate 和 postgres 两个容器里（T14） |
| H-06 harness 无状态 | harness 没有数据库，状态只能通过 session API 读写；租约 fencing；**A-01 部分：消费跟踪 + sweeper 保证未消费的输入一定会被处理（§6.4、§7.4）；出票事件对账** | §7.4 列出的 5 个测试（T06 / T09 / T15）；崩溃测试的 harness 部分在 A-02 |
| H-07 凭证隔离 | 机密只以文件挂载，每个容器只挂自己那一列（D-28，§2.3）；环境变量里没有机密；compose 里没有机密插值；`EnvSecretProvider` 在生产环境被禁用；网络分段；日志 redact | `verify-deploy.sh` 第 1、2 步（T14）；`SecretProvider` 的 3 个测试（§2.4，T00）；pre-commit 的密钥扫描（T00）；日志 redact 测试（T06） |
| H-08 不信任输入 | 所有路由都用 TypeBox schema 校验，`additionalProperties: false`；ajv 设成 `coerceTypes:false, removeAdditional:false, useDefaults:false`（D-24）；有请求体大小上限；公共事件视图按白名单裁剪；markdown 渲染不执行 HTML | ① 每个路由的非法请求测试；② **ajv 配置测试**（每个服务各一份）：多带一个字段、或者把数字写成字符串，都必须返回 400；③ 静态检查：除了 `@fb/platform/fastify`，任何地方都不能出现 `Fastify(` 或 `ajv:` 配置（T00）；④ XSS 用例；⑤ 公共视图裁剪测试（§4.5，T06）；⑥ 转义函数的红队用例（§4.3，T01 / T13） |
| H-09 供应链 | `.npmrc`：`ignore-scripts=true`、`save-exact=true`；最短发布时间限制（pnpm 的 `minimumReleaseAge`，**写在哪个文件里由 T00 用实际的 pnpm 版本确认**，S-16）；Dockerfile 里用 `pnpm install --frozen-lockfile --ignore-scripts`；用 `node:sqlite` 避免原生编译 | `pnpm check` 检查 lockfile 里的版本都是精确版本，`.npmrc` 和最短发布时间的配置都存在（T00）；镜像构建日志里不能出现任何 install script 的执行（T14） |
| H-10 过程留痕 | 事件日志本身就是审计记录；本文和所有 D-xx 都落盘；`prompt history/` 保存 coding agent 的原始导出，只对密钥做脱敏 | pre-commit 对 `prompt history/` 做密钥扫描（匹配 `sk-` 开头的 key、所有 secret 文件的内容，T00）；收尾检查清单：确认导出文件是原样的、没有被编辑（T16） |

---

## 14. 本文相关的决策（正式记录见 [decisions.md](../adr/decisions.md)）

### 14.1 已确认、并且已经落到本文里的
| 编号 | 结论（简写） | 落到本文的位置 |
|---|---|---|
| D-21 | Node 24 LTS | §2.1 |
| D-22 | `node:sqlite`，只读 | §1.2、§13 H-03 |
| D-23 | 拿到域名之前用 HTTP + 虚拟机 IP | §10 |
| D-24 | TypeBox；ajv 不转换类型、不删除字段 | §4.1、§13 H-08 |
| D-25 | agent 文本里的链接显示成纯文本 | §9.4 |
| D-26 | 出网不加白名单，只预留扩展点 | §2.6、§2.7 |
| D-27 | SPA 合并进 Caddy 镜像 | §2.1 |
| **D-28** | **Compose file-based secrets 挂到 `/run/secrets/*`，不放进环境变量；`SecretProvider` 接口；不部署 vault** | §2.3、§2.4、§10、§13 H-07（B-1） |
| D-29 | 一次对话一个会话 | §3.1 |
| D-30 | 不存在的用户名自动注册 | §4.3 |
| D-31 | 运行中途的消息照常接受 | §4.3、§6.4、§7.4 |
| D-32 | 记忆只插入；整理流程 v1 不做 | §3.2、§17 |
| D-33 | v1 不做停止按钮 | §4.3、§9.2 |
| D-34 | fence 以 Redis 为主，`max_fence_seen` 兜底 | §5.1 第 4 步、§7.2 |
| D-35 | `nearest_served_city` 不单独做成工具 | 不影响 A-01 |
| D-36 | 守卫命中后撤回、重写，再不行就换模板 | §9.4、§9.5 |
| D-37 | 中文城市名：LLM 翻译，代码匹配 | §9.6（界面只显示原文） |
| D-38 | 记忆只存枚举偏好 | §3.2（`key` 的 CHECK） |
| D-39 | 出票后 agent 不说话 | §5.2、§6.4、§9.3.1 |
| D-40 | 运行上限 | §7.4（45 秒阈值的推导引用了它） |
| D-41 | 低档推理 | 不影响 A-01（thinking 块在公共视图里被去掉，§4.5） |
| D-42 | 不要 `avoid_transfer_city` | §3.2（`key` 的 CHECK） |
| D-43 | 语言按 CJK 字符比例判断 | §9.6 |
| D-44 | 工具默认并行执行 | §5.5（hands 不做会话级串行化） |
| D-45 | 记忆召回渲染成 `key: value` 行 | 不影响 A-01 |
| D-46 | 上下文专题调研（R-02） | §6.1（结论落在 D-52..D-58，见 §14.2） |
| D-47 | 崩溃后先重放，失败再写 interrupted | §5.5（规范化哈希让重放能命中缓存） |
| D-48 | 不用 strict 工具参数 | 不影响 A-01 |
| D-49 | 动态上下文从 `run_started` 投影 | §4.5（公共视图去掉 profile） |
| D-50 | `max_tokens` 4096 | 不影响 A-01 |
| **D-51** | **出票失败时也不唤醒 agent** | §5.2、§6.4、§9.3.1（B-2） |
| R-U1 | 前端和后端由不同的会话来写 | §1.3 |

### 14.2 D-52..D-63（2026-11-18 拍板）对本文的影响
| 编号 | 结论（简写） | 落到本文的位置 |
|---|---|---|
| **D-52 🔁** | 压缩由 harness 里独立的 compactor 在运行开始前一次性完成，写入 `agent.context_compacted`；projector 只做投影（用户原话："投影函数只做投影的职责。我们就一次性来压缩"） | §5.1 第 3 步：正式加入写入白名单，只有 harness 能写，必须带 fence；§4.5：公共视图是 `hidden`；§6.3；§6.4：不影响消费跟踪 |
| D-53 | 已结束运行的 thinking 全部保留 | 不影响 A-01（thinking 在 `messageJson` 里，公共视图不解析它，§4.5） |
| **D-54** | `messageJson` 存原样字符串；哈希仍然用 `canonicalJson` | §6.1；§5.1 第 1 步：大小上限 64 KB；§4.5：公共视图去掉它 |
| **D-55** | 运行期间到达的 `booking.*` 由 projector 挂到下一次运行的边界上 | §5.2、§6.4：确认和 `consumed_up_to_seq` 的语义不冲突，gateway 不需要改动 |
| D-56、D-57、D-58 | 不加 `get_quote`；水位默认值；验收方式 | 不影响 A-01 |
| **D-59** | 出网白名单**不提前**，写进局限一节 | §2.7、§12 已经是这样写的；§17 |
| **D-60** | 每条输入一个门铃 `wake-{sid}-{seq}`；恢复扫描用 `wake-{sid}-scan-{周期}` | §7.3、§7.4。v0.4 的 A2-3（harness 自己按门铃）作废 |
| D-61、D-62 | 模糊匹配只有一个建议时的处理；拦截 LLM 复述用户自己给的数字 | 不影响 A-01（守卫在 A-02；前端只看守卫的结果） |
| **D-63 🔁🔁 / D-64 🔁**（2026-11-19） | 用户原话："D63 64 我统一回复下 中间 react 之类的过程都需要短暂显示中间reasoning文本"。**ReAct 中间过程要短暂显示**：运行期间流式文字和推理文本照常推送，在过程区以弱化样式显示；带工具调用的消息的文字留在过程区，最终回复产生或运行结束时折叠；最终回复照常显示。安全约束：过程区标明"中间过程，不作为报价依据"；不在本次运行工具结果里的数字由 harness 打码；报价卡仍然是数字唯一的权威来源 | §4.4（去掉 `AGENT_DELTA_MODE=off` 的默认值）、§4.5（`kind:'process'`、`agent.reasoning_delta`）、§9.4、§9.4.1（过程区）、§9.5、§12、§13 H-01、§16.3 A2-12 / A2-13 / A2-17 |
| **C-7（父会话裁定）** | `replaced` 时被拒绝的消息从不落库，只另写一条模板消息 | §9.4：前端规则写定，不再保留两种情况 |

### 14.3 本文的待决策
- **没有遗留的待决策。** v0.5 提出的 D-64 已于 2026-11-19 由人决定（见 §14.2）。A-01 当时推荐的方案 A（完全不推送）**没有被采纳**，正文已按人的结论修改。
- 本轮没有新的取舍需要编号。

---

## 15. 归属表核对（W1-seams 里归 A-01 的行 → 本文章节）
| W1-seams 里归 A-01 的行 | 章节 |
|---|---|
| 进程清单、compose 网络分段、凭证和环境变量 | §2.1–2.4 |
| 浏览器 ↔ gateway 的 REST / SSE、CSRF、cookie 会话 | §4 |
| Postgres 表结构、数据库角色和授权、谁能写哪张表 | §3 |
| 事件信封和持久化规则 | §6.1–6.2 |
| 事件类型目录（用户侧和系统侧） | §6.3 |
| session 内部 API 的 HTTP 形状、鉴权、分页 | §5.1 |
| 确认下单链路（校验项、幂等、错误码） | §5.2、§4.6 |
| 报价的存储和归属 | §3.2（`quotes`、`quote_offers`、`tickets`）、§3.3 |
| 长期记忆的数据表和用户查看 / 删除接口 | §3.2（`user_memories`、`memory_deletions`）、§4.3 |
| 中英双语的界面文案和 i18n 方案 | §9.6 |
| 可观测性：traceId 透传、日志格式、预留 OTel 接口 | §8 |
| 评测方法里前端和 E2E 的部分 | 下表 |

**前端和 E2E 的评测点**（供 T13 / T15 使用；验收报告指出 v0.3 没有通过标准，这里补上）：
| # | 评测点 | 怎么判定 | 通过标准 |
|---|---|---|---|
| 1 | 报价卡上的数字正确 | 抽取至少 200 条路线（覆盖直飞、1 次换乘、2 次及以上换乘），卡片上的每个数字都等于 oracle（T04）的结果 | **100%** |
| 2 | 不点按钮绝不出票 | 用户用文字说"确认""yes""好的，帮我订"等至少 20 种说法，然后检查 tickets 表的行数没有变化 | **100%** |
| 3 | 重复确认只出一张票 | 双击、20 个并发请求、刷新页面后重试 | **100%** 只有一张票 |
| 4 | 用户之间的隔离 | 用户 A 用各种方式访问用户 B 的会话、报价、机票、记忆 | **100%** 返回 404 |
| 5 | SSE 断线续传 | 在流式输出中途断开、重连 | 消息不丢、不重复（100%） |
| 6 | 双语文案完整 | 两份 i18n 文件的 key 集合完全一致；切换语言后页面上没有未翻译的 key | **100%** |
| 7 | XSS 和链接 | agent 文本里带 `<script>`、链接、图片 | 不执行、不能点击、不加载（100%） |
| 8 | 出票后 agent 不发言（D-39 / D-51） | 确认成功或失败之后，日志里都没有新的 `agent.run_started`；出票卡片上的票号、航段和价格等于数据库里的值；用户再发一条消息时，agent 能正确提到出票结果 | 前两项 **100%**；第三项按 A-02 §14.2 的通过率 |
| 9 | 输入校验 | 每个服务：多带一个字段、或者把数字写成字符串，都返回 400 | **100%** |
| 10 | 运行中途的消息（B-3） | 在运行进行中发送第二条消息 | 在 60 秒内被下一次运行处理（100%） |
| 11 | 公共视图不泄露内部内容 | 回放和 SSE 里不出现 thinking、系统提示词、toolResult 的 data、profile | **100%** |
| 12 | 同名城市不合并 | 分别订 San Jose 和 San José 的票 | 两张票的城市名分别是原文，互不混淆（100%） |
| 13 | 过程区（D-63 / D-64） | 构造一次会调用工具的对话，检查实时画面、回放和断线重连 | ① 带工具调用的 assistant 消息在公共视图里全部是 `kind:'process'`，文字只在 `processText` 里，**永远不出现在气泡里**；② 过程区始终带"中间过程，不作为报价依据"的提示；③ 过程区里不出现本次运行工具结果之外的数字（实时推送和落库两处都要查；打码由 harness 负责，这里做端到端验证）；④ 最终回复落库或运行结束后自动折叠；⑤ 刷新页面后过程区只有落库的步骤，没有推理文本（全部 100%） |

---

## 16. 接缝

### 16.1 A-02 R-1..R-10 的状态
| A-02 的需求 | A-01 的处理 | 状态 |
|---|---|---|
| R-1 getEvents 升序分页；emitEvent 带 fence 和幂等键；wake | §5.1（emit 改成一次一个事件）；§7.3 | ✅ |
| R-2 fence 校验返回 409 FENCE_STALE；幂等键重复返回第一次的 seq | §5.1 第 4、6 步（加上 Redis 数据丢失后的重置） | ✅ |
| R-3 写入类型白名单；`quote.offered` 校验 | §5.1 第 3、5 步 | ✅ |
| R-4 hands token | §5.3（JWS EdDSA，5 分钟，带 fence 申请，只签发给活动中的会话） | ✅（X-1 已同意） |
| R-5 临时事件的通道；`delta{reset}` | §4.4、§9.5 | ✅ |
| R-6 报价卡的渲染要求 | §9.3 | ✅ |
| R-7 user.message 转义；长度限制 | §4.3（规则加强了，S-7） | ✅ |
| R-8 表 | §3.2（`quote_redemptions` 删掉了，O-1；记忆只插入，X-3 已同意） | ✅ |
| R-9 `booking.confirmed` 带 summary | §4.5 给出了 `TicketSummary` 的定义；按 D-39 不唤醒 | ✅ |
| R-10 `meta.template` | §6.3：放在 `payload.meta.template` | ✅ |

### 16.2 验收报告里的接缝矛盾 C-1..C-18 的处理
| # | 处理 | 位置 |
|---|---|---|
| C-1 `booking.failed` 是否唤醒 | 已改：不唤醒（D-51） | §5.2 |
| C-2 status 推导 | 已改：只有未消费的 `user.message` 会让状态变成 queued；运行结束时如果还有未消费的输入，状态是 queued | §6.4 |
| C-3 恢复扫描的阈值 | 已改：10 秒 / 45 秒 / 每 15 秒，和 A-02 一致；判断依据改成"未消费的输入"，不看 status | §7.4 |
| C-4 delta 的关联键 | 已改：按 messageKey 精确替换 | §9.5 |
| C-5 X-1 / X-3 的状态 | 已移到"已解决" | §16.4 |
| C-6 `guard_violation` 的字段 | 已改：messageKey；v0.5 按 A-02 v0.4 收窄成 `regenerate` / `replaced` 两种 | §9.4 |
| C-7 `replaced` 时原消息有没有落库 | **父会话已裁定**：从不落库，只另写一条模板消息。§9.4 已按裁定写定 | §9.4 |
| C-8 `booking.confirmed` 的 payload 和 `TicketSummary` | A-01 给出了定义；需要 A-02 在 §2.3 补上 `ticketNo` | §4.5；§16.3 |
| C-9 `meta.template` 放在哪 | 统一放在 `payload.meta.template`；需要 A-02 §2.1 补上 | §6.3；§16.3 |
| C-10 thinking 和 system 消息给不给前端 | 已改：新增公共事件视图，按白名单裁剪 | §4.5 |
| C-11 记忆的来源 seq | 需要 A-02 在 execute 信封里加 `inputSeq` | §5.5；§16.3 |
| C-12 重放一致性和 jsonb | 已改：哈希用 `canonicalJson`；`messageJson` 正式加入（D-54 ✅） | §5.5、§6.1 |
| C-13 工具并发 | 已改：hands 不做会话级串行化；需要 A-02 §6.2 同步 D-44 | §5.5；§16.3 |
| C-14 fence 的取号顺序 | 建议 A-02 改成"SET NX 成功之后再 INCR"，避免抢锁失败的 worker 把正在持锁的 worker 挤成 STALE。A-01 的 Lua 校验对两种顺序都正确 | §16.3 |
| C-15 自己按门铃 | 已按 D-60 统一：每条输入一个 `wake-{sid}-{seq}`，扫描用 `wake-{sid}-scan-{周期}`；harness 不再自己按门铃 | §7.3 |
| C-16 `session.created` | 已删除这个事件（O-8），矛盾不再存在 | §6.3 |
| C-17 execute 的 trace 头 | 已统一：platform 的 HTTP 客户端自动加 `traceparent` 和 `X-Trace-Id`；需要 A-02 §5.1 补上 `X-Trace-Id` | §8；§16.3 |
| C-18 一致的部分 | 不变 | — |

### 16.3 需要 A-02 配合修改的地方（由父会话转达）
v0.5 按 A-02 v0.4 重新核对了一遍：

| # | 内容 | 原因 | 状态 |
|---|---|---|---|
| A2-1 | execute 信封加 `inputSeq: number`（本次运行 `inputSeqs` 里最后一条 user.message 的 seq） | I-6 / C-11：`user_memories.source_seq` 不能为空 | ⏳ A-02 v0.4 里还没有 |
| A2-2 | 工具幂等的 key 加上 runId：hands 侧是 `(session_id, run_id, tool_call_id)`；A-02 §3.7 的 `msg:tr:{toolCallId}` 建议同步改成 `msg:tr:{runId}:{toolCallId}` | S-15：不假设厂商的 toolCallId 跨运行唯一 | ⏳ A-02 v0.4 仍是 `msg:tr:{toolCallId}` |
| ~~A2-3~~ | ~~harness 自己按门铃时的 jobId~~ | — | ✅ **作废**：D-60 之后 harness 不再自己按门铃（A-02 v0.4 §3.1） |
| A2-4 | 每次新开运行时，`inputSeqs` 包含**全部**未消费的 `user.message`，按 seq 顺序；`consumedUpToSeq = max(inputSeqs)` | §6.4 的 `consumed_up_to_seq` 依赖这条性质 | ✅ A-02 v0.4 §2.1、§3.3 已经满足，请保持 |
| A2-5 | 抢租约时只有 SET NX 成功之后才 INCR fence | C-14 | ✅ A-02 v0.4 §3.2 的 acquire 脚本已经这样做 |
| A2-6 | `booking.confirmed` 带 `ticketNo`；`summary` 引用 A-01 §4.5 的 `TicketSummary` | C-8 | ✅ A-02 v0.4 §2.4 |
| A2-7 | `agent.message.payload.meta.template` | C-9 | ✅ A-02 v0.4 §2.1 |
| A2-8 | 默认并行执行工具 | D-44 | ✅ A-02 v0.4 §6.2 |
| A2-9 | execute 请求头补上 `X-Trace-Id` | X-9、C-17 | ⏳ 影响很小：platform 的 HTTP 客户端会自动加 |
| A2-10 | 恢复扫描看"未消费的输入"和"未结束的运行"，不看 status | B-3 | ✅ A-02 v0.4 §3.1 W1 / W2 |
| ~~A2-11~~ | ~~C-7 的裁定~~ | — | ✅ 父会话已裁定：不落库 |
| **A2-12** | `agent.message.payload` 增加 `hasToolCalls: boolean`（assistant 消息里有没有 toolCall）。带工具调用的消息：`viewText` 一律是 `""`，文字改放在 **`processText`**（打码后的，见 A2-17）。gateway 根据 `hasToolCalls` 把这类消息投影成 `kind:'process'`，不解析 `messageJson`（§4.5） | D-63 / D-64 🔁 | 🆕（v0.6 修订） |
| **A2-13** | D-64 已决：harness **照常推送** `agent.delta`，并新增 `agent.reasoning_delta`（推理文本的流式片段，带 fence，单条 ≤ 4 KB）。gateway 的 `AGENT_DELTA_MODE` 默认改成 `stream`，只作为运维的应急开关（§4.4） | D-64 🔁 | 🆕（v0.6 修订） |
| **A2-17** | **打码**（D-64 的安全约束）：harness 在推送 `agent.delta`、`agent.reasoning_delta` 之前，以及写入 `processText` 之前，把**不在本次运行工具结果的数字集合**里的数字替换成 `MASK_TOKEN`（`@fb/contracts/web` 的常量，建议 `•••`）。数字识别和允许集合可以复用 numberGuard（A-02 §8.4）的规则。**最终回复不打码**，它照常走 numberGuard（通过才落库）。流式 delta 没法预知自己是不是最终回复，所以**一律打码**；最终回复落库后，气泡显示的是没有打码、并且通过了守卫的 `viewText`（§9.5） | D-64、H-01 | 🆕 |
| **A2-14** | A-02 v0.4 §10 第 864 行仍然写着"第一次运行用 `session.created.locale`"，和它自己第 127 行"改从 `GET /internal/v1/sessions/:id` 的 `locale` 读取"矛盾。A-01 v0.4 已经没有 `session.created`，请以第 127 行为准 | O-8 | 🆕 |
| **A2-15** | 消费跟踪列的名字和含义：A-01 采用 A-02 的命名 `last_user_seq` / `last_user_at` / `consumed_up_to_seq` / `open_run_id`。另外两处不同：① W1 的"最早那条未消费消息的时间"由 A-01 新增的 `oldest_unconsumed_at` 提供，而不是 `last_user_at`（§6.4 解释了原因）；② W2 用的是 `last_agent_event_at`（只统计 harness 写入的事件），而不是 A-02 写的 `last_event_at`（所有事件）。这样用户在 harness 卡死期间持续发消息，也不会把 W2 的计时一直往后推。请 A-02 §3.1 / §16.3 C-4 同步这两个名字 | B-3 | 🆕 |
| **A2-16** | 临时事件的信封带 `fence`（A-02 v0.4 §2.2 / C-7）：A-01 已经实现，gateway 扇出时丢掉 `fence < lease:fence` 的临时事件（§4.4） | A-02 C-7 | ✅ A-01 已实现 |

### 16.4 已经解决、不再是问题的
- X-1（hands token 用签名）、X-3（记忆只插入）、X-4（messageKey）、X-11（扫描阈值）：A-02 §16.2 已经同意，本文已按答复修改。
- X-2（`quote.offered` 由谁写）、X-6（Quote 的字段）、X-8（harness 不需要 userId）：v0.2 已经解决。
- X-9（trace 头）：父会话已裁定（§8）。
- X-10（停止按钮）：D-33。
- X-12（schema 库）：D-24。
- X-13（出票失败时是否唤醒）：D-51。
- X-14（A-02 同步 D-39）：A-02 v0.3 §3.1 已经同步；A-02 v0.4 进一步明确了 `booking.*` 不是输入（§2.4），A-01 §5.2 原来"把 booking.confirmed 当成待处理输入"的说法已在 v0.5 删除。
- 还没解决、留给开发阶段验证的：X-5（BullMQ 的 jobId 能不能包含 `:`），由 T06 / T09 验证。

---

## 17. 下一步（不在 v1，写进最终设计文档的"下一步"一节）
| 项目 | 说明 | 来源 |
|---|---|---|
| **长期记忆的整理和合并流程** | 人的原话："持久化的记忆应该有时间和职责上独立的处理流程"。做成一个**独立的后台 worker**，不在对话的运行里做：定期把 `user_memories` 的墓碑、被替换的旧值和删除记录合并成一份紧凑的画像，再按保留策略清理超期的原始行。它只能以专门的维护角色运行，和 hands 的写入路径分开 | D-32 |
| 出网白名单代理 | 部署 smokescreen 或 squid，只放行 DeepSeek 的域名；harness 通过 `EGRESS_PROXY_URL` 接入，不需要改代码（§2.6） | D-26、D-59 |
| 真正的账号体系 | 密码或第三方登录；这是关闭 §2.7 剩余风险的另一半 | D-08 |
| 机密管理升级 | 换成 OpenBao 或 Vault，使用动态数据库凭证；`SecretProvider` 新增一个实现即可 | D-28 |
| fence 和租约都放进 gateway / Postgres | 关闭 §5.1 的毫秒级窗口，同时让被攻破的 harness 无法自己签 fence | D-34 方案 B |
| 停止生成按钮 | `user.interrupt` 事件，加上 A-02 的 abort 语义 | D-33 |
| 退票、改签 | 把 `tickets` 改成只插入的 `ticket_events` | D-13 |
| 限流 | 按用户和 IP 限流（Redis 令牌桶） | D-13 |
| OTel 接入 | 部署 Collector，实现 `Tracer` 接口 | D-11 |
| 工具幂等缓存的清理 | `tool_calls` 按保留期清理（由维护任务执行） | §3.2 |
| 多副本部署 | 各服务横向扩展；sweeper 已经有分布式锁 | O-4 |

---

## 18. v0.4 变更记录（验收问题 → 修改位置）

### 18.1 阻塞项和重要项（全部修复）
| 编号 | 问题 | 怎么修的 | 位置 |
|---|---|---|---|
| B-1 | D-28 已确认，正文仍是 env 文件 | 机密改成文件挂载；8 个容器的机密矩阵；`SecretProvider`；部署脚本和 H-07 的检查方式都改了 | §2.3、§2.4、§10、§13 H-07 |
| B-2 | D-51 已确认，正文仍写"按门铃" | 出票失败不唤醒；`booking.*` 不改变跟踪列和状态 | §5.2、§6.3、§6.4 |
| B-3 | 运行中途的消息可能没人处理 | 契约不变量；消费跟踪列；status 只用于显示；按消息生成 jobId；sweeper 按"未消费的输入"补门铃；不变量的论证；5 个测试；对 A-02 的接缝要求 | §0、§3.2、§6.4、§7.3、§7.4、§16.3 |
| I-1 | gateway 其实能出网 | edge 只留 caddy；新增 internal 的 front 网络 | §2.2 |
| I-2 | 下单链路在网络层没有保证 | 固定子网、按网卡绑定、来源地址检查、pg_hba，写出了 compose 和 Fastify 的配置；同时如实写出被攻破的进程能做什么（选择和理由见 §2.2） | §2.2、§2.7、§12、§13 H-02、D-59 |
| I-3 | gateway 没有权限重置 fence | ACL 改成可写；Lua 算法写全，不再需要哨兵 key；测试 | §5.1 第 4 步、§7.2 |
| I-4 | 公共 API 原样返回内部事件 | 新增 `PublicEvent` 白名单裁剪；`@fb/contracts/web` 只导出公共视图；测试 | §1.3、§4.3、§4.4、§4.5 |
| I-5 | jsonb 不保留键的顺序 | `canonicalJson` 用于哈希和幂等比较；预留 `messageJson`（待 D-54） | §1.2、§5.1 第 6 步、§5.5、§6.1 |
| I-6 | hands 拿不到 `source_seq` | 要求 A-02 在信封里加 `inputSeq`；hands 校验它的范围，并获得 `last_user_seq` 列的读权限 | §3.2、§3.3、§5.5、§16.3 A2-1 |
| I-7 | 批量 emit 的去重和 seq 没定义清楚 | 改成一次写一个事件；201 / 200 区分清楚；冲突处理写明 | §5.1 |
| I-8 | 登录接口无法满足 CSRF 规则；没有请求体的请求被要求带 Content-Type | 规则改成一张表：登录豁免 CSRF token；没有请求体的请求不检查 Content-Type；登录时轮换会话 | §4.2 |
| I-9 | 对账只在启动时运行 | 改成 sweeper 每 15 秒对账一次 | §5.2、§7.4 |
| I-10 | hands token 局限的描述比实际轻 | 如实写出 harness 的能力；只给活动中的会话签发 token | §2.7、§5.3、§7.2 |
| I-11 | 接缝状态过期，阈值冲突 | 阈值和 A-02 一致；按 messageKey 替换；X-1/3/4/11 移到"已解决" | §7.4、§9.5、§16.4 |
| I-12 | 守卫事件的渲染规则和 A-02 的字段对不上 | 改用 messageKey 和 A-02 的三种 action；规则对 C-7 的两种结果都适用 | §9.4 |
| I-13 | 机密矩阵只列了 4 个服务 | 列全 8 个容器；角色由 postgres 初始化时创建；migrate 只持有 owner 的密码 | §2.3、§3.4 |
| I-14 | 有几条测试证伪不了 | H-02 加上 8080 不可达的测试；"CI"改成 `pnpm check` 和 pre-commit；H-05 的说法降低；H-06 补上 A-01 部分的测试；H-10 补上 prompt history 的检查 | §13、§7.4 |

### 18.2 建议项（采纳 / 不采纳）
| 编号 | 结论 | 理由或位置 |
|---|---|---|
| S-1 | 采纳 | booking 用 `ApiError` 信封；映射表；新增 `SERVICE_UNAVAILABLE`；修正了 §11 里的 503 / 500 冲突（§4.6、§5.4、§11） |
| S-2 | 采纳 | JWS compact、EdDSA、kid、30 秒时钟偏差；注明 uid 对 harness 可见（§5.3、§13 H-04） |
| S-3 | 采纳 | cursor 格式写明；会话列表可能重复，前端去重；机票列表的排序键不会变（§4.1） |
| S-4 | 采纳 | 临时事件先校验再转发；`evt` 通知回数据库读取；退出登录关闭 SSE（§4.2、§4.4、§7.1）。剩余风险写进 §2.7 |
| S-5 | 采纳 | 先规范化再校验长度（§4.3） |
| S-6 | 采纳 | `key` 加 CHECK；复合外键（§3.2） |
| S-7 | 采纳 | NFKC + 正则覆盖空格、`/`、实体形式（§4.3） |
| S-8 | 采纳 | "同名必须同义"；统一 `*_NOT_FOUND` 的含义为"在调用方的可见范围内不存在"（§4.6） |
| S-9 | 采纳 | §14.1 列全 D-21..D-51；§5.5 写明同一个会话里的并发 |
| S-10 | 采纳 | platform 拆成子入口；harness 不能依赖 `pg`（§1.2） |
| S-11 | 采纳 | `@fb/contracts/server` 可以使用 `node:crypto`（§1.2） |
| S-12 | 采纳 | 哈希常量移出机密矩阵，不接受环境变量覆盖（§2.3） |
| S-13 | 采纳 | 唯一冲突时最多重试 3 次（§5.2） |
| S-14 | 采纳 | 删掉 `pg_column_size` 的 CHECK；由 gateway 按原始字节数检查（§3.2、§5.1） |
| S-15 | 采纳 | 主键加上 run_id；对 A-02 提出接缝要求（§3.2、§16.3 A2-2） |
| S-16 | 采纳 | 交给 T00 用实际的 pnpm 版本确认（§13 H-09） |
| S-17 | **部分采纳** | 采纳：幂等键格式 `user:{clientMessageId}`。不采纳：比较原文。理由：转义是确定性的，转义后相同的两段文本，LLM 看到的内容完全一样；为了比较原文，还得多存一份原文的哈希（§4.3） |

### 18.3 简化建议（O-1..O-8）
| 编号 | 结论 | 理由或位置 |
|---|---|---|
| O-1 删掉 `quote_redemptions` | 采纳 | `tickets.quote_id UNIQUE` 加 `ON CONFLICT (quote_id) DO NOTHING`（§3.2、§5.2） |
| O-2 一次写一个事件 | 采纳 | §5.1 |
| O-3 确认请求不带 sessionId | 采纳 | 删掉 `QUOTE_SESSION_MISMATCH`（§4.3、§4.6、§5.2） |
| O-4 每个服务一个副本 | 采纳 | §2.1 |
| O-5 删掉 `refSeq`、`schema_version`、双标识 | **部分采纳** | 删掉 `refSeq`；票号从 ticket id 派生。**保留 `schema_version`**：它是以后迁移事件 payload 格式时唯一的判断依据，而事件日志又不能改写；保留它几乎没有成本（§3.2、§6.1） |
| O-6 三个后台任务合并 | 采纳 | sweeper；fence 重置改成在 emit 时按需处理，所以只剩两个子任务（§7.4） |
| O-7 不用 ULID | 采纳 | 随机 base32，CHECK 规则不变（§1.2、§3.2） |
| O-8 删掉 `session.created` | 采纳 | §4.3、§6.3 |

### 18.4 父会话的其他要求
| 要求 | 位置 |
|---|---|
| 新的契约不变量（未消费的输入必须在有限时间内被处理） | §0、§6.4、§7.4 |
| jsonb 键顺序：预留 `messageJson`，标"待 D-54" | §6.1、§14.2 |
| `agent.context_compacted`：在白名单里预留，标"待 D-52" | §5.1 第 3 步、§4.5、§14.2 |
| 数据陷阱：San Jose / San José，一律用原始的 `city_name` | §3.1、§9.6、§9.7、§15 第 12 条 |
| 新的取舍从 D-59 开始编号 | §14.3 |

### 18.5 v0.5 变更记录（契约变更广播：D-52..D-63、C-7 裁定、和 A-02 v0.4 对齐）
| 来源 | 改了什么 | 位置 |
|---|---|---|
| D-52 🔁 | `agent.context_compacted` 正式进入事件目录和写入白名单：只有 harness 能写，必须带 fence，公共视图是 `hidden`，不影响消费跟踪；"待 D-52"的标记已删除 | §4.5、§5.1 第 3 步、§6.3、§6.4、§14.2 |
| D-54 ✅ | `messageJson` 正式加入；哈希仍然用 `canonicalJson`；事件大小上限从 128 KB 改回 64 KB（和 A-02 v0.4 一致：不再同时存一份结构化消息） | §3.2、§5.1 第 1 步、§6.1 |
| D-55 ✅ | 确认：`booking.*` 不是输入，不影响 `consumed_up_to_seq`；D-55 只决定 projector 把它投影到哪里，和 gateway 不冲突，gateway 不需要改动。删掉了 v0.4 里"booking 会成为待处理输入"的说法 | §5.2、§6.4、§16.4 |
| D-59 ✅ | 出网白名单不提前；§2.7 和 §12 已经按"局限"写好 | §14.2 |
| D-60 ✅ | 门铃：每条输入一个 `wake-{sid}-{seq}`；扫描用 `wake-{sid}-scan-{floor(epochMs/15000)}`；`removeOnFail: true`；harness 不再自己按门铃，A2-3 作废 | §7.1、§7.3、§7.4 |
| D-63 🔁 | 带工具调用的 assistant 消息在公共视图里一律是 `hidden`（即使 `viewText` 不为空）；需要 A-02 加 `hasToolCalls`（A2-12）；前端的渲染表同步修改 | §4.5、§9.4、§16.3 |
| D-63 → **D-64（新）** | 流式输出时无法提前知道一条消息会不会带工具调用，所以"不推送它的 delta"只能通过"完全不推送"或者"推送后撤回"来实现。新增待决策 D-64（推荐完全不推送）；gateway 先实现 `AGENT_DELTA_MODE` 开关 | §4.4、§9.5、§14.3 |
| C-7 裁定 | `replaced` 时被拒绝的消息从不落库。§9.4 写定，删掉了"两种情况都适用"的写法 | §9.4、§16.2 |
| 对齐 A-02 v0.4 | 消费跟踪列改用 A-02 的命名（`last_user_seq`、`last_user_at`、`consumed_up_to_seq`），新增 `oldest_unconsumed_at`；`run_started` 改用 `consumedUpToSeq`，并校验它等于 `max(inputSeqs)`；公共视图里 toolResult 的字段名改成 `toolName`；assistant 的文字只取 `viewText`；守卫 action 只剩 `regenerate` / `replaced`；删掉了 `agent.status`；临时事件按 fence 过滤 | §3.2、§3.3、§4.4、§4.5、§5.1、§6.4、§7.4、§9.4、§16.3 |
| §16.3 重新核对 | A2-4..A2-8、A2-10 已由 A-02 v0.4 满足；A2-3、A2-11 作废；仍然待办的是 A2-1、A2-2、A2-9；新增 A2-12..A2-15 | §16.3 |


### 18.6 v0.6 变更记录（最后一轮广播：D-63 再次修订、D-64 已决、R-U2）
| 来源 | 改了什么 | 位置 |
|---|---|---|
| D-64 🔁 | 去掉 `AGENT_DELTA_MODE=off` 的默认值，改成 `stream`，开关只作为运维的应急手段；临时事件新增 4 KB 的大小上限 | §4.4 |
| D-64 🔁 | 公共临时事件新增 `agent.reasoning_delta`（推理文本），并整理成一张表 | §4.5 |
| D-63 🔁🔁 | 带工具调用的 assistant 消息落库后不再是 `hidden`，改成 `kind:'process'`，文字放在 `processText`，**永远不进入气泡**；最终回复是 `kind:'reply'` | §4.5、§9.4 |
| D-64 🔁 | 新增 §9.4.1 过程区：位置和样式、内容来源、打码的显示方式、折叠时机、断线重连和回放的规则、i18n 文案；全部按纯文本渲染 | §9.4.1、§9.5 |
| D-64 的安全约束 | 过程区固定显示"中间过程，不作为报价依据"；数字由 harness 打码（A2-17）；气泡只显示落库后、通过了守卫的最终回复；报价卡仍然是数字唯一的权威来源 | §9.4.1、§9.5、§12 ⑦、§13 H-01 |
| 对 A-02 的要求 | A2-12 改成 `processText`；A2-13 改成"照常推送，并新增 `agent.reasoning_delta`"；新增 A2-17（打码规则） | §16.3 |
| D-64 已决 | §14.3 不再有待决策；D-63 / D-64 的结论记录在 §14.2 | §14.2、§14.3 |
| 评测 | §15 第 13 条改成过程区的 5 项检查 | §15 |
