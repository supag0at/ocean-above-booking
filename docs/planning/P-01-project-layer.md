# P-01 项目层设计（草案 v0.1，待人确认）

- 日期：2026-11-18
- 状态：✅ v1.0（项目层决策 D-01 到 D-14 全部确认，2026-11-18）。决策清单见 [decisions.md](../adr/decisions.md)，**没有回复的决策不算通过**。
- 范围：human-in-the-plan 三层规划里的**项目层**（目标、约束、硬规则、整体架构、决策清单）。
- 后续三份设计规范（D-01），都以本文为底座：
  1. `A-01 前后端架构设计` → 结构层：模块和仓库切分、接口 / 数据归属 / 运行拓扑等契约；
  2. `A-02 Agent 整体设计` → 结构层：harness、工具、上下文、状态生命周期、失败语义、安全边界；
  3. `A-03 DAG 开发流程与执行 agent 职责` → 任务层：任务 DAG、执行单元、模型档位、验收方式。
- 调研依据：[R-01](../research/R-01-pi-and-managed-agents.md)

---

## 1. 目标

### 1.1 必须达成（来自题目）
| 编号 | 要求 | 验收要点 |
|---|---|---|
| G-01 | 支持自然语言输入 | 中英文、拼写和重音变体（Sao Paulo / São Paulo） |
| G-02 | `locations.db` 是唯一数据源 | 城市、坐标、航线只从库里读；库文件哈希不变 |
| G-03 | 航线规则 | 直飞只有 hub↔hub（hub_links）和 spoke↔其 connected_hubs；双向；只能在枢纽换乘 |
| G-04 | 没有直飞时找最便宜路线，多段出一张票 | 和独立参考实现全量对拍 |
| G-05 | 距离 = 欧氏距离；价格 = 总距离 × 0.13 USD | 精度与舍入规则写进契约 |
| G-06 | 下单前确认完整路线、距离、价格 | 没有确认就无法下单，由代码保证 |
| G-07 | 无服务城市要告知用户，并推荐最近的有服务城市 | 10 个无服务城市全覆盖 |
| G-08 | 能用自然语言查询已订机票 | 只返回本人的票 |
| G-09 | 能查看全部历史对话 | 会话列表 + 完整回放 |

### 1.2 交付物
1. 代码 + README（运行方式）；部署在虚拟机上，域名稍后提供。
2. 设计文档（题目列出的 5 个必答点）。
3. `prompt history/` 文件夹：所有 coding agent 会话的**原始**导出，只对密钥做脱敏。
4. 可选扩展（D-13 ✅）：
   - **自建评测集**：航线和价格全量对拍、无服务推荐、确认流程（不点按钮绝不出票）、红队提示注入、中英文用例；
   - **中英双语**：界面文案和对话都支持，agent 跟随用户使用的语言回答；
   - **用户画像推荐（长期记忆）**：跨会话记住用户偏好（常用出发地、常飞航线、语言等），用来给出推荐。记忆只能当作推荐依据，不能当作事实或指令；用户可以查看和删除。
   - 退票、限流、乘客信息、多城市行程不做，写进设计文档的"下一步"。

### 1.3 不做
- 不上 Kafka、K8s、服务网格、多区域部署。但队列、事件日志、模型调用都要**抽象成接口**，以后可以替换。
- 不做真实支付，不做完整的账号安全体系（题目说明不需要）：登录只填用户名（D-08），写进设计文档的"局限"一节。
- 不推远程仓库，只用本地 git（D-14）。
- 不部署 OTel Collector 和 Langfuse，只预留接口（D-11）。
- 不引入第三方 pi packages（理由见 R-01 §1.4）。

---

## 2. 硬规则（草案，确认后写进 CLAUDE.md，能机器判定的做成检查）

| 编号 | 规则 | 怎么机器判定 |
|---|---|---|
| H-01 | **所有航线、距离、价格只由确定性代码根据 `locations.db` 计算**。LLM 不计算、不改写数字；给用户看的数字来自系统渲染的结构化报价卡，不来自 LLM 生成的文本。 | 对拍测试；输出检查：回复里出现的数字必须能在本轮工具结果里找到 |
| H-02 | **agent 没有任何下单途径**（D-06）。LLM 只能决定什么时候出示报价卡和确认按钮；下单只由**用户点击按钮**发出的 HTTP 请求触发（经 gateway → booking），并且要校验报价 ID、session 归属、有效期，每个报价只能用一次。自然语言的"确认"不会下单。 | 契约测试：工具清单里没有下单类工具；harness 的环境变量里没有订单库写凭证，网络上也到不了 booking 接口；确认接口只接受带 CSRF token 的浏览器会话请求；同一报价重复提交只成功一次 |
| H-03 | `locations.db` 只读。服务启动时加载到内存，并校验 sha256。 | 启动时自检；CI 检查哈希 |
| H-04 | 身份只来自服务端会话（cookie → userId），**工具参数里永远不出现 userId 或其他身份字段**。 | 契约测试：扫描所有工具的 schema |
| H-05 | session 事件日志只追加，不允许更新或删除。 | 数据库权限（只授予 INSERT/SELECT）+ 测试 |
| H-06 | harness 无状态：任何时候杀掉进程，都能靠 `wake(sessionId)` 从日志恢复。 | 崩溃测试 |
| H-07 | 凭证隔离：LLM key 只在 harness 进程；订单库写凭证只在 booking 进程；gateway→booking 的服务间凭证只在这两个进程；浏览器和 LLM 永远拿不到任何凭证；任何密钥都不进 git。 | 检查每个容器的环境变量；compose 网络隔离测试；提交前扫描密钥 |
| H-08 | LLM 输出和用户输入一律当作不可信数据；工具参数严格按 schema 校验，多余字段直接拒绝。 | schema 测试 + 红队用例 |
| H-09 | 供应链：依赖精确锁版本，`npm ci --ignore-scripts`，新依赖只能在依赖冻结阶段由父会话添加。 | CI 检查 lockfile 和 `.npmrc` |
| H-10 | 过程记录：`prompt history/` 存原始会话，不编辑；决策、契约变更、验收结论都要写进文档。 | 收尾检查清单 |

---

## 3. 整体架构（草案）

### 3.1 进程拓扑（参照 Managed Agents 的 session / harness / hands 三分）

```
 浏览器 (web SPA)
    │  HTTPS (REST + SSE)
    ▼
 ┌─────────── Caddy（反向代理，拿到域名后自动 HTTPS）───────────┐
 │                                                            │
 │  gateway  ── 拥有 Session ──────────────────────────────┐  │
 │   · 登录 / cookie 会话                                   │  │
 │   · POST /sessions/:id/messages → 追加 user 事件        │  │
 │   · POST /quotes/:id/confirm   → 用户确认（下单入口）   │  │
 │   · GET  /sessions/:id/stream  → SSE 推送事件           │  │
 │   · 调用 wake(sessionId) 入队                           │  │
 │        │ Redis：wake 队列 / 每 session 一把租约锁 / SSE 扇出 │
 │        ▼                                                │  │
 │  harness（N 个无状态 worker）── Brain                   │  │
 │   · pi-agent-core Agent + pi-ai                         │  │
 │   · 被唤醒 → getEvents → prepareRequest 重建上下文      │  │
 │   · subscribe → emitEvent 追加回日志                    │  │
 │   · 只持有 LLM key + session 级 hands token            │  │
 │        │ execute(name, input)   (HTTP, 内网)            │  │
 │        ▼                                                │  │
 │  hands ── Hands（领域工具服务）                          │  │
 │   · 城市解析 / 无服务推荐 / 航线引擎 / 报价 / 查票       │  │
 │   · locations.db 只读加载进内存                          │  │
 │   · 报价写入 quotes 表（不可变）                         │  │
 │                                                         │  │
 │  booking（独立进程 / 容器，D-07）                         │  │
 │   · 唯一持有 tickets 表写凭证的进程                       │  │
 │   · 只接受 gateway 的内网调用（服务间凭证）              │  │
 │   · harness / hands 的网络到不了它                        │  │
 └────────────────────────────────────────────────────────────┘
        Postgres：users / sessions / events(只追加) / quotes / tickets
```

### 3.2 一次订票的数据流
1. 用户输入"下周从上海飞圣保罗"→ gateway 追加 `user.message` 事件 → `wake(sessionId)`。
2. harness 拿到租约 → 读事件 → 重建 Agent → 模型调用 `resolve_city` 和 `quote_route`（都通过 hands 执行）。
3. hands 用确定性 Dijkstra 算出路线，生成**不可变报价** `quote{id, legs[], distance_km, price_usd, expires_at, session_id}`，作为结构化结果返回。
4. harness 发出 `quote.presented` 事件，前端用系统模板渲染**报价卡**（每一段航程、换乘城市、距离、价格、确认按钮）。LLM 的文字只做解释，不负责展示数字。
5. 用户**点击**报价卡上的"确认下单"按钮（D-06：只有这一个入口；用户用文字说"确认"时，agent 只会再出示一次按钮）→ gateway 校验 cookie 会话和 CSRF token，再转给 booking → booking 校验（报价属于本 session 的用户、已出示过、未用过；报价不过期，D-10）→ 在一个事务里写入 ticket，并把报价标记为已用 → 追加 `booking.confirmed` 事件 → 唤醒 harness 生成回复。
6. 查票："我订过哪些票" → 工具 `list_my_tickets()`（没有参数，身份来自 session token）。
7. 历史对话：前端读 gateway 的会话列表和事件回放。

### 3.3 Agent 工具集（草案，最终签名在结构层冻结）
| 工具 | 作用 | 副作用 |
|---|---|---|
| `resolve_city(query)` | 名称 → 规范城市名（去重音、模糊匹配、给出候选），附带服务状态 | 无 |
| `nearest_served_city(city)` | 无服务城市 → 最近的有服务城市 | 无 |
| `quote_route(from, to)` | 算出最便宜路线并生成报价 | 写不可变的 quote 记录（幂等） |
| `offer_booking(quote_id)` | LLM 判断用户有订票意向时调用：发出 `quote.offered` 事件，前端用系统模板渲染报价卡和"确认下单"按钮 | 只追加一个事件，**不下单** |
| `list_my_tickets(filter?)` | 查本人已订机票 | 无 |
| ~~`book`~~ | **不存在**。下单只能由用户点击按钮触发（D-06） | — |

### 3.4 技术选型（推荐，待 D-xx 确认）
| 层 | 推荐 | 理由 |
|---|---|---|
| 语言 | 后端全部 TypeScript，Node 22.19+ | pi 的硬性要求；契约类型可以前后端共享 |
| Agent | `@earendil-works/pi-agent-core` + `pi-ai`，精确锁版本（D-02 ✅） | 用户指定；内核小、钩子齐全 |
| LLM | DeepSeek Flash 档（D-05 ✅），经 pi-ai 的 DeepSeek provider 接入 | 用户已有 key；model id 在脚手架阶段确认 |
| 主存储 | Postgres 16 | gateway、harness、hands、booking 多个进程都要写；SQLite 是单写者 |
| 缓存 / 队列 | Redis 7（+ BullMQ，见 D-04） | 用户允许；用于 wake 队列、租约锁、SSE 扇出、限流 |
| Web 服务 | Fastify | 原生支持 schema 校验，性能好 |
| 前端 | React + Vite SPA | 静态资源由 Caddy 直接托管 |
| 部署 | Ubuntu 24.04 虚拟机 + Docker Compose + Caddy | 用户要求本地化部署在虚拟机上；拿到域名后 Caddy 自动申请证书 |
| 容器 | caddy、web（静态资源，可以合并进 caddy）、gateway、harness（可多副本）、hands、booking、postgres、redis | booking 独立（D-07）；harness 和 hands 所在网络段到不了 booking |
| 可观测性 | pino 结构化日志 + traceId 贯穿全部进程；预留 OTel 接口（D-11） | 轻量，需要时再接 Collector |
| 版本控制 | 本地 git（D-14） | 不推远程 |

---

## 4. 主要风险
| 风险 | 应对 |
|---|---|
| LLM 用地理常识改写结果（比如"Austin 离 Copenhagen 很远"） | H-01 + 系统提示明确"世界是虚构的" + 评测用例 |
| 用户说"好的"被误判成确认，导致误下单 | D-06：只有点击按钮才会下单，文字永远不会触发 |
| DeepSeek Flash 的工具调用不够稳定（参数不对、该调工具时直接编数字） | 严格 schema 校验 + H-01 的输出数字检查 + 评测集；适配层保留切换厂商的能力 |
| pi 的 API 还在变（1.x，近期刚换 scope） | 精确锁版本；pi 的调用全部收进 harness 里的一个适配层 |
| 无状态重建上下文没有官方示例 | 脚手架阶段先做一个 spike 验证（任务层第一个任务） |
| 验收方和执行方用同一个模型，存在同源偏差 | 验收至少用 T2 档，并且和执行方用不同会话、不给开发过程 |
