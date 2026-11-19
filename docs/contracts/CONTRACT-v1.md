# 契约 v1（v1.0.1，2026-11-19；v1.0 在 G1 冻结）

- 日期：2026-11-19；作者：父会话（C-01 合并，T1）
- 状态：✅ **v1.0 已冻结**（2026-11-19 G1，用户原话："确认冻结"）。之后任何修改都要走 §5 的变更流程，升级版本号并广播。T01 已把本文落实成代码（契约包、迁移、契约测试）。
- 依据：A-01 v0.6、A-02 v0.6、[decisions.md](../adr/decisions.md)（D-01 到 D-64、R-U1 到 R-U3）、S-01、R-01、R-02。
- 设计文档不再复核（R-U2）：本文直接以两份 v0.6 为准，把它们之间剩下的差异裁定掉。

---

## 1. 哪些内容具有约束力，冲突时以谁为准

### 1.1 规范来源（normative）
| 类别 | 规范来源 | 契约包中的落点（T01） |
|---|---|---|
| ① 接口：公共 REST / SSE、视图类型、错误码 | A-01 §4 | `@fb/contracts/web` |
| ① 接口：内部 API（session / booking / hands） | A-01 §5 | `@fb/contracts/server` |
| ① 接口：事件信封和持久化规则 | A-01 §6.1、§6.2 | `@fb/contracts/server` |
| ① 接口：事件类型（用户侧和系统侧） | A-01 §6.3 | `@fb/contracts/server` |
| ① 接口：事件类型（agent 侧，含 `agent.message` 字段、临时事件） | A-02 §2 | `@fb/contracts/server` |
| ① 接口：`execute(name, input)` 信封、工具 schema、agent 侧错误码 | A-02 §5、§7 | `@fb/contracts/tools` |
| ① 接口：flight-core 的接口和计算口径 | A-02 §7.6 + 本文 §3 | `@fb/contracts/flight` |
| ② 数据归属：表结构、角色、授权 | A-01 §3 | `infra/db/migrations/`（原 T05 并入 T01） |
| ③ 运行拓扑：容器、网络、端口、机密、Redis key 和 ACL | A-01 §2、§7 | `infra/compose/`、`@fb/platform/secrets` |
| ④ 状态与生命周期：唤醒、租约、fence、消费跟踪、sweeper | A-02 §3（harness 侧）+ A-01 §6.4、§7.3、§7.4（gateway 侧） | 契约测试 |
| ④ 上下文：projector、compactor、渲染格式 | A-02 §4 | 契约测试（前缀性质测试、黄金测试） |
| ⑤ 失败语义 | A-01 §11 + A-02 §12 | 错误码表 + 测试 |
| ⑥ 安全边界 | A-01 §12、§13 + A-02 §8、§13 | 契约测试（§4） |
| 前端结构 | A-01 §9 | `apps/web/`（T11） |

### 1.2 冲突时的优先级
1. `decisions.md` 里人的原话；
2. 本文 §2 的裁定；
3. 按 §1.1 的归属，以负责那一块的文档为准，**不负责的那一方的描述作废**；
4. 实现中发现规范没有覆盖到的情况：停下来，上报父会话，不要自己选。

---

## 2. 合并裁定（v0.6 之间剩下的差异）

| 编号 | 差异 | 裁定 | 理由 |
|---|---|---|---|
| M-1 | 带工具调用的 assistant 消息落库之后怎么展示：A-02 §2.3 写的是公共视图里 `hidden`，A-01 §4.5 / §9.4.1 写的是 `kind:'process'`（折叠的过程区） | **按 A-01**：显示为 `kind:'process'`。D-64 的意思是"运行结束后折叠收起"，所以这些消息落库之后也要能看到。A-02 §2.3 第 126 行的 `hidden` 作废 | D-64 🔁 |
| M-2 | 过程区文字落库之后怎么存：A-01 A2-17 要求增加 `processText` 字段（打码后的文字），A-02 §8.7 只给临时推送打码 | 🔁 2026-11-19 **不打码**（用户原话："不需要打码"）。harness 对 `hasToolCalls:true` 的消息，把 assistant 的文字**原样**写进 `processText`，`viewText` 留空 `""`；公共视图只输出 `processText`。`messageJson` 仍然只给模型用，**不出现在任何公共视图里**。A-02 §8.7 的打码器和 A-01 A2-17 的打码要求**整体作废**；`MASK_TOKEN` 不再需要。过程区保留"中间过程，不作为报价依据"的标注。最终回复的数字守卫（A-02 §8.4）不变 | 有了 `processText`，刷新页面后折叠的过程区还能显示；打码按用户的决定去掉 |
| M-3 | `agent.message` 的 payload 字段 | 以 A-02 §2.1 / §2.3 为准，**再加上** `processText?: string`（M-2）。`meta: { template, ending }` 放在 `payload.meta` 里（A-01 C-9 和 A-02 C-6 一致） | A-02 负责这一块 |
| M-4 | 临时事件 `agent.reasoning_delta` | 按 A-02 C-14：`{ runId, messageKey, textDelta }`，带 fence，单条不超过 4 KB；**不打码**（M-2）。公共视图 `PublicEphemeral` 加上这个事件 | D-64 |
| M-5 | `agent.guard_violation` 有哪些 action | 只有 `regenerate` 和 `replaced`。被拒绝的消息从不落库（C-7 裁定）。A-01 里凡是提到 `stripped` 的地方作废 | A-02 v0.4 已经简化 |
| M-6 | 幂等键 | hands 端用 `(session_id, run_id, tool_call_id)`；`quote.offered` 的 idempotencyKey 是 `offer:{runId}:{toolCallId}`；toolResult 的 messageKey 是 `tr:{runId}:{toolCallId}`，idempotencyKey 是 `msg:tr:{runId}:{toolCallId}`（M-14 修正） | A2-2，不假设厂商给的 toolCallId 跨运行唯一 |
| M-7 | 门铃 jobId | `wake-{sid}-{seq}`；sweeper 用 `wake-{sid}-scan-{floor(epochMs/15000)}` | D-60 |
| M-8 | 消费跟踪的列 | `last_user_seq`、`consumed_up_to_seq`、`open_run_id`、`oldest_unconsumed_at`、`last_agent_event_at`，含义以 A-01 §6.4 为准 | A2-15 |
| M-9 | trace 头 | `traceparent` 必须带；`X-Trace-Id` 附带一份，值是 traceparent 里的 trace-id 部分；由 platform 的 HTTP 客户端自动加上 | X-9 |
| M-10 | `AGENT_DELTA_MODE` | 默认值 `stream`，放行 `agent.delta` 和 `agent.reasoning_delta`；`off` 只是运维的应急开关 | D-64 |
| M-11 | 契约包里各入口之间能不能互相 import（草稿里 `ErrorCode`、`Quote`、`TicketView`、execute 信封都被复制了多份） | **分层**：web ← flight ← tools ← server。web 什么都不 import；flight 只能 import web；tools 能 import web 和 flight；server 可以 import 全部。层级由 depcruise 规则 `contracts-flight-direction` 和 `contracts-tools-direction` 强制。`contracts-forbidden` 只作用于 `src/`，契约测试可以读文件 | 去掉重复定义，同时 web 入口仍然不会把服务端代码带进浏览器 |
| M-12 | 单一来源 | `ErrorCode` 合并为一份（A-01 §4.6 的 19 个，加上 A-02 §5.3 agent 侧的码），放在 web，因为 `run_failed` 和 `booking.failed` 的 code 会出现在公共视图里；`run_failed.code` 和 `booking.failed.code` 的类型都用它。`Quote` / `QuoteLeg` / `TicketView` / `TicketSummary` 放在 web，flight 和 server 直接引用，不再复制。execute 信封只放在 tools（§1.1），删掉 server 里的那份。幂等键和 messageKey 的构造函数只放在 server，删掉 tools 里的那份 | 防止定义漂移 |
| M-13 | **前端不能算价格** | `PRICE_PER_KM_USD` **只放在 flight**，web 里删掉。web 只提供展示用的格式化函数：`formatUsdCents`、`formatKm`，按 D-09 舍入，入参是 API 已经算好的值 | H-01：浏览器端不应该有任何能算出价格的东西 |
| M-14 | M-6 的笔误 | toolResult 的 **messageKey** 是 `tr:{runId}:{toolCallId}`，**idempotencyKey** 是 `msg:tr:{runId}:{toolCallId}`。以 A-02 §3.7 为准 | server 子块发现的问题 |
| M-15 | `format` 关键字 | 契约里**一律不用** `format`（比如 `'uuid'`），改用 `pattern`，uuid 的 pattern 统一放在 web 里作为常量 | 避免依赖 ajv-formats，Fastify 和 pi 的行为也能保持一致 |
| M-16 | `agent.message` 的 schema | 在 server 里按 role 拆成区分联合：`system`；`assistant` 分成两种——带工具调用的必须满足 `hasToolCalls:true, viewText:"", processText`，不带的满足 `hasToolCalls:false, viewText`；`toolResult` 必须有 `toolCallId`、`toolName`、`isError` | 规则由 schema 强制，不依赖 gateway 手写检查 |
| M-17 | 临时事件的 fence | 内部的临时事件信封带 `fence`（A-02 §2.2）；公共视图里的临时事件是 `{ type, payload }`，不带 fence | A-02 负责这一块 |
| M-18 | 补齐 server 入口 | 增加 `escapeUserText()`，按 A-02 §11.1 转义 `<system_event` 和 `<run_context`，包括大小写变体、全角字符、零宽字符；从 flight 重新导出 `LOCATIONS_DB_SHA256` | A-01 §1.3 要求的内容 |
| M-19 | 草稿里其他的 TODO | 接受下面这些做法：转写表取两份文档的并集，另外补上 Ð→D、Ħ→H、Þ→TH；`matchedBy` 可选；`list_my_tickets` 返回 `TicketView[]`；save/forget 的返回值是回显；`FlightCore` 的接口先按草稿，T03 实现时如果需要改，就上报；`run_` 前缀用随机串；记忆 ID 的前缀是 `m_`；登录用户名先校验长度 1..64，规范化后再校验 1..32 | 都在规范允许的范围内 |
| M-20 | 数据库 | 保留 `REVOKE ALL … FROM PUBLIC` 和"先全部 REVOKE 再 GRANT"这两个补充；v1 的迁移和 GRANT 由 `00-roles.sh` 执行，不单独做 migrate 容器；compose 要把 `infra/db` 以只读方式挂进 postgres 容器（`INFRA_DB_DIR`）；密码只在初始化期间出现在容器内部 psql 进程的 argv 里，写进局限一节 | 数据库子块的 TODO |
| M-21 | 整合时剩下的两处 | `booking.confirmed` 和 `booking.failed` 由 **gateway** 写入（A-01 §5.2、§3.3：booking 没有 events 表的授权，gateway 收到 booking 的同步应答后再写事件）；公共视图里 toolResult 那一支**不加** `kind`，前端按有没有 `toolCallId` 来区分（A-01 §9.4）；`list_my_tickets` 返回 `TicketView[]`；`ExecuteResponse.error.code` 保持为 agent 错误码的子集 | 都按负责方文档的原文 |
| M-22 | 打平规则和舍入写得不够具体（T04 提出） | **v1.0.1 澄清**：①"字典序"指对原始城市名逐个比较 Unicode 码点（JS 的 `<` 比较或者 Python 默认的字符串比较），**不用 `localeCompare`，不忽略大小写**；比较对象是途经城市名组成的序列。② `priceCents = Math.round(totalKm × 13)`，正数时是四舍五入。③距离平局的容差是 1e-6 km，按"每个候选都和当前最优比较"的方式处理。④只产生简单路径（不重复经过同一个城市） | 两个独立实现要做全量对拍，口径必须逐字一致 |

---

## 3. 全局常量和口径（T01 写进契约包，所有实现都只能引用这里，不能各自硬编码）
| 常量 | 值 | 来源 |
|---|---|---|
| `PRICE_PER_KM_USD` | `0.13` | 题目 |
| 距离和价格的舍入 | 内部用未舍入的 float64 计算；展示时距离保留 2 位小数，价格四舍五入到 0.01 USD | D-09 |
| 打平规则 | 总距离相同时，段数少的优先；段数也相同时，按城市名序列的字典序 | D-09 |
| `LOCATIONS_DB_SHA256` | `fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f` | R-01 §4 |
| 规范化 | NFKD → 去掉组合符号 → 转写表（ø→o、ł→l、æ→ae、ß→ss 等）→ 小写 → 去掉标点 → 合并空格；**规范化后出现重名（比如 San Jose 和 San José）时一律返回 ambiguous** | R-01 §4、A-02 §7.1 |
| 运行上限 | 8 轮、12 次工具调用、单次请求 60s、单次运行 120s、restartLimit 3 | D-40 |
| `max_tokens` | 4096 | D-50 |
| 压缩水位 | H=40k、L=16k，摘要最多 20 条报价 | D-57 |
| 模型 | `deepseek-flash`，低档推理，不用 strict 模式 | D-05、D-41、D-48 |
| 依赖版本 | `@earendil-works/pi-agent-core@1.5.2`、`@earendil-works/pi-ai@1.5.2`；其余依赖的精确版本在 T01 统一锁定 | S-01、H-09 |

---

## 4. 契约测试清单（T01 编写，从 W3 起每次 `pnpm check` 都要跑）
| # | 断言 | 对应的规则 |
|---|---|---|
| CT-01 | 所有工具 schema 里都没有 `userId`、`user`、`username`、`sessionId` 这类身份字段 | H-04 |
| CT-02 | 工具清单里没有任何"下单"类工具（名字或描述里出现 book、ticket.create、confirm 等，需要人工确认白名单） | H-02 |
| CT-03 | 依赖规则：harness 不能 import 任何 `services/*`；gateway 和 booking 不能 import flight-core；`apps/web` 只能 import `@fb/contracts/web` | A-01 §1.2、R-U1 |
| CT-04 | 每个容器的 compose 配置里都**没有**机密环境变量，机密只以 secrets 文件挂载；harness 拿不到 booking 和数据库的 secret | H-07、D-28 |
| CT-05 | compose 的网络矩阵：harness 和 hands 在网络上到不了 booking；只有 booking 加入了 `db_booking` 网络 | D-07、A-01 §2.2 |
| CT-06 | 数据库授权：`events` 表任何角色都没有 UPDATE 或 DELETE 权限；`tickets` 表只有 booking 角色能 INSERT；每个服务的角色只拥有 A-01 §3.3 里写明的权限（用真实的 Postgres 执行 GRANT 矩阵来测） | H-05、A-01 §3.3 |
| CT-07 | （由 T02 platform 负责）Fastify 的 ajv 配置是 `coerceTypes:false, removeAdditional:false`；多余字段一律返回 400 | D-24 |
| CT-08 | `beforeToolCall` 对原始参数执行 `Value.Check`：给 2.5、"1"、多余字段，都必须被拦截 | D-24、S-01 Q9 |
| CT-09 | 公共视图里永远不出现 `messageJson`、thinking 和 system 消息 | M-2、A-01 §4.5 |
| CT-10 | `locations.db` 的 sha256 等于常量；运行时以只读方式打开 | H-03 |
| CT-11 | 事件 schema 的白名单：每种事件只允许 A-01 §6 和 A-02 §2 规定的那个写入方写 | 数据归属 |
| CT-12 | （由 T09 负责，作为 T09 的验收标准）前缀性质测试：同一份日志，在较早位置截断后的投影结果，必须是较晚位置截断后投影结果的前缀（两个截断点之间没有压缩事件时） | D-58 |

---

## 5. 变更流程
- 只有父会话能修改契约。流程是：评估影响 → 需要的话问人 → 修改版本号 → **同一轮内**广播给所有受影响的会话 → 在 `CHANGELOG.md` 里记录。
- 执行者发现契约有问题时，按 A-03 §5 上报，然后停下来等回复。
