# A-01 前后端架构设计 · 独立验收报告（正交验收）

- 被审对象：`docs/design/A-01-frontend-backend.md`（草案 v0.3，1028 行）
- 审查日期：2026-11-18
- 审查依据：题目原文、P-01（H-01..H-10）、`docs/adr/decisions.md`（只认 ✅ / 🔁）、`docs/tasks/W1-seams.md`、`docs/tasks/A-01.md` 的验收标准；对照 `docs/design/A-02-agent.md` v0.3（只核对接缝）。
- 说明：`docs/tasks/A-01.md` 末尾的"汇报"是作者的自述，本报告**没有**把它当作证据，结论都来自正文核对。
- 数据核对：`locations.db` sha256 = `fc4134475ab5…07386f`，和 A-01 §1.1、A-02 §7.6 一致；711 个城市，其中 40 个枢纽，10 个无服务城市，151 条 hub_links。数据库只以只读方式打开。

---

## 1. 结论：**不通过**（修完阻塞项后可以转为"有条件通过"）

整体骨架是对的：session / harness / hands / booking 四个进程分开；harness 没有数据库凭证，也到不了 booking；报价卡只从 API 取数；确认下单走"主键只能插入一次"；表都只能插入，并有触发器兜底。这些设计都站得住。

但是不通过的原因有三类：
1. **两条已确认的决策没有落实**：D-28 和 D-51。正文仍按旧写法实现，开发者照文档写代码就会违背决策。
2. **一个会丢用户消息的状态机缺陷**：§6.3 的状态推导、§7 的门铃 jobId、恢复扫描三者叠加导致（B-3）。
3. **几处"安全论断比实际机制强"**：gateway 的网络其实能出网；gateway 的公共 API 在 app 网络里也能访问到；harness 能给任意会话签 hands token；gateway 没有权限重置 fence。

另外，§16 的接缝状态已经过期：A-02 v0.2 已经答复过的 X-1、X-3、X-4、X-11 仍然标成待确认，而且阈值和 A-02 不一致。

统计：**阻塞 3 项，重要 14 项，建议 17 项**（含疑问）。

---

## 2. 验收标准逐条核对（`docs/tasks/A-01.md`）

| # | 验收标准 | 判定 | 依据 |
|---|---|---|---|
| 1 | 归属表里 A-01 负责的每一行都有对应章节 | **通过** | §15 把 W1-seams 里归 A-01 的 12 行逐行映射到章节，我逐行抽查都能找到。"hands execute 信封：A-01 放进拓扑和鉴权"在 §5.5 和 §2.4。小瑕疵：§15 写的"评测方法里前端和 E2E 的部分"只是 9 条要点，没有通过标准（A-02 §14 每条都有通过率） |
| 2 | 前后端相关的契约写到可以直接实现的粒度（字段、类型、错误码、授权语句） | **部分通过** | DDL（§3.2）、GRANT（§3.3）、公共 API 表（§4.3）、错误码（§4.6）、emit 的 7 步校验（§5.1）都写到了实现粒度。但有一批会让开发者卡住或者写错的缺口：登录接口和 CSRF 规则自相矛盾（I-11）；批量 emit 的去重和 seq 分配没定义（I-10）；`user_memories.source_seq` 是 NOT NULL，但 hands 拿不到这个值（I-9）；凭证矩阵和已确认的 D-28 冲突（B-1）；hands token 的编码格式、booking 的错误信封、列表 cursor 的格式都没写（S-1 到 S-3）；8081 "只监听 app 网络"没有给出实现手段（I-5） |
| 3 | 每条硬规则 H-01..H-10 都写清"架构上怎么保证"和"用什么测试验证" | **部分通过** | §13 每条都有两列，形式上齐全。实质问题：H-02 缺少"harness / hands 访问 gateway:8080"的测试（I-5）；H-07 的测试方式按 D-28 已经失效（B-1），凭证矩阵也漏了 migrate、postgres、redis 三个容器（I-16）；H-03、H-09 的测试写的是 "CI"，但 D-14 规定只用本地 git，没有 CI；H-10 只有"收尾检查清单"，没提 `prompt history/`；H-05 说"即使是表的 owner 也不能改或删"，这个说法过强（owner 可以 DISABLE 或 DROP TRIGGER）。详见 I-17 |
| 4 | 新的取舍按 D-xx 格式列在文末，不自己定 | **部分通过** | §14 把 DA-xx 换成了 D-21..D-34，并区分了已确认和待确认，做法正确。但是：① §5.2 失败表"本文暂时按'按门铃'写"，等于在决策落定之前**先选了一个选项写进正文**，而且选的是后来被否决的那个；② 新的取舍用的是 X-13 这样的编号（不是 D-xx），放在接缝表里，和验收标准要求的格式不一致；③ §14 没有收录 D-44 到 D-51，也没写它们落在哪一节 |
| 5 | 接缝问题单独成节 | **通过（内容过期）** | §16 单独成节，16.1 逐条答复 R-1..R-10，16.2 列出 X-xx。但 X-1、X-3、X-4、X-11 在 A-02 §16.2 里已经全部答复，A-01 仍标成"需要确认"；X-13 已经由 D-51 定了，也还标成待定（见第 4 节） |

---

## 3. 问题清单

严重度：**阻塞** = 照着文档实现，就会违背已确认的决策，或者出现功能性缺陷；**重要** = 安全论断失实、契约缺口，或者会导致实现返工；**建议** = 改进项，或者需要澄清的疑问。

| 编号 | 严重度 | 位置 | 问题 | 依据 | 建议修复方式 |
|---|---|---|---|---|---|
| B-1 | 阻塞 | 文首状态、§2.3、§10 "验证命令"、§13 H-07、§14.2 | **D-28 已经确认，但正文仍是旧写法**。文首写"D-28（机密怎么分发）还在等人确认，§2.3 暂时保持 v0.2 的写法"。§2.3 是"每个服务一个 env 文件"，`DATABASE_URL`、`REDIS_URL`、`DEEPSEEK_API_KEY` 都作为环境变量下发。§10 的验证方法是"`docker compose exec harness env` 输出里不能有 `DATABASE_URL`…"。 | decisions.md D-28 ✅："用 Docker Compose 的 file-based secrets，按服务挂载到 `/run/secrets/*`，**不放进环境变量**；代码里通过 `SecretProvider` 接口读取" | 把 §14.2 里 A-01 自己的 6 条意见转成正文：§2.3 改成"secret 文件 × 容器"矩阵；`DATABASE_URL` 拆成"普通配置里的主机、库名"加上"secret 文件里的密码"；§10 和 H-07 的检查改成"列出每个容器 `/run/secrets` 下的文件，和白名单比对"，同时断言 env 里没有机密；platform 新增 `SecretProvider`，并用测试断言生产镜像里禁用"回退到环境变量" |
| B-2 | 阻塞 | §5.2 失败表最后一行、§6.3 状态推导第 1 行、§16.2 X-13 | **D-51 已经确认，但正文仍写"按门铃"**。§5.2 原文："本文暂时按'按门铃'写"。§6.3 原文："写入 `user.message` 或 `booking.failed`，并且按了门铃 → `queued`"。和 A-02 合起来会出现实际故障：A-02 §3.3 规定 `booking.*` 不算输入，harness 被唤醒后发现 pending 为空，直接结束，**不会写 run_started**，于是会话一直停在 `queued`。A-02 §12（X-11）的恢复扫描规则是"queued 超过 10s 就重新按门铃"，结果就是每 15 秒按一次门铃，永远不停。 | D-51 ✅："出票失败时……不唤醒，和 D-39 一致；前端在报价卡上显示本地化的错误"；A-02 §16.3 C-2、C-3 | §5.2 删掉按门铃；§6.3 改成"**只有** `user.message` 会让状态变成 `queued`"；`booking.failed` 和 `booking.confirmed` 都不改变状态；X-13 标为已由 D-51 解决 |
| B-3 | 阻塞 | §6.3 状态推导、§7 门铃格式和恢复扫描 | **用户在运行中途发的消息可能永远没人处理**（D-31 场景）。过程如下：① 运行中途来了一条 `user.message`，gateway 按门铃，但同一个 jobId `'wake-'+sessionId` 的任务正处于 active 状态，BullMQ 会把这次按门铃当作重复任务忽略；② 按 §6.3，harness 写 `agent.run_completed` 时状态变成 `idle`，但这时还有没处理的输入；③ A-02 §3.5 的"释放后再检查"在**同一个 job 还没结束时**用同一个 jobId 自己按门铃，同样会被去重吞掉；④ 恢复扫描只扫 `status IN ('queued','running')`，`idle` 的会话扫不到。最后这条消息只能等用户再发一条消息，才会被一起处理。（"active 状态的同 jobId 任务会让新任务被忽略"是 BullMQ 的已知语义，但请 T06 / T09 用实际版本确认。） | §6.3："harness 写入 `agent.run_completed` → `idle`"；§7："jobId: 'wake-' + sessionId … removeOnComplete: true"；A-02 §3.5；D-31 ✅ | 三处都要改：① 状态推导：写入 `run_completed` 或 `run_failed` 时，如果存在 `seq >` 本次运行 `max(inputSeqs)` 的 `user.message`，就设成 `queued`，不设成 `idle`（gateway 可以在同一个事务里算出来）；② 自己按门铃时用不会撞车的 jobId（比如 `wake-{sid}-{lastSeq}`），或者在 job 结束之后再按（BullMQ 的 completed 事件或延迟任务）；③ 恢复扫描再加一条：`idle`，但存在没被消费的 `user.message`。T06 / T09 增加"运行中途发消息"的集成测试 |
| I-1 | 重要 | §2.2 网络表和可达性矩阵 | **gateway 其实能出网，和矩阵的说法矛盾**。`edge` 网络是"internal 否（Caddy 之后要申请证书）"，成员是 "caddy, gateway"；但矩阵里写"gateway → 公网 ❌"。gateway 持有 `HANDS_TOKEN_SIGNING_KEY`、`COOKIE_SECRET`、`BOOKING_SERVICE_TOKEN`。 | H-07："compose 网络隔离测试"；§2.2 原文 | 拆成 `edge`（只有 caddy，可以出网）和 `front`（caddy + gateway，`internal: true`）；可达性测试增加"在 gateway 容器里访问公网必须失败" |
| I-2 | 重要 | §0 不变量 2、§2.2、§4.2、§5.1、§10 | **"下单只有一条路（浏览器点按钮）"在网络层没有保证**。gateway 的公共 API :8080 同样监听在 `app` 网络上（文档只说 8081 "只监听 app 网络"，没说 8080 不监听 app，也没给出按网卡绑定的方法）。harness 和 hands 都在 `app` 网络里，可以直接请求 `gateway:8080`。按 D-08，只要知道用户名就能 `POST /auth/login` 拿到 cookie 和 csrf；`Origin` 和 `X-CSRF-Token` 对非浏览器客户端都能伪造。所以一个被攻破的 harness（它可以出网，而且依赖面很大，见 A-02 §6.2"pi-ai 会把所有厂商的 SDK 都装进来"）只要知道或者枚举出用户名，就能替用户确认已经出示过的报价。另外，"只有 :8081 只监听 app 网络"在 compose 里没有现成的做法（需要静态 IP，或者启动时按网卡解析地址）。 | H-02："网络上也到不了 booking 接口"、"确认接口只接受带 CSRF token 的浏览器会话请求"；D-06 🔁："agent 完全没有直接下单的途径" | 把公共 API 和内部 API 拆成两个容器（`gateway-public` 只接入 front / bk / db_main；`session-api` 只接入 app / db_main），或者给容器配静态 IP，再按 IP 绑定端口；可达性矩阵加上"harness / hands → gateway:8080 ❌"这一格，并写进 T14 / T15 的网络测试；§12 的"已知弱点"补上这条（D-08 本身的局限） |
| I-3 | 重要 | §7 Redis ACL、§7 "lease:fence 丢失"、§5.1 第 1 步、D-34 | **D-34 的兜底在权限上做不到，流程也没写全**。gateway 的 ACL 是 `%R~lease:fence:*`（只读），但 §7 要求"gateway 根据 `sessions.max_fence_seen` 把 fence 重新设成一个更大的值"，这需要写权限。另外，"怎么发现 Redis 数据丢了"（GET 返回 nil？）、"在这之前拒绝所有 emit"的具体判定，都没有写。如果只靠 `>= max_fence_seen` 来判断，新 worker 从 1 开始计数，会被永久拒绝。 | D-34 ✅："Redis 为主，Postgres 的 `max_fence_seen` 兜底"；§7 ACL 原文 | 明确写出算法：emit 时如果 `GET lease:fence:{sid}` 是 nil，gateway 执行 `SET lease:fence:{sid} <max_fence_seen+1> NX`，然后返回 `409 FENCE_STALE`，让持有旧 fence 的 worker 停下，新 worker 下一次 INCR 就会大于旧值。ACL 给 gateway 开 `lease:fence:*` 的 SET NX 权限（`~lease:fence:*` 加上必要的命令）。T06 增加"清空 Redis 后旧 worker 被拒绝、新 worker 能写入"的测试 |
| I-4 | 重要 | §4.3 `GET /sessions/:id/events`、§4.4 SSE、§6.1、§9.4 | **公共 API 原样返回 agent 的内部事件**。`EventEnvelope.payload` 里的 `agent.message` 带着：thinking 块（A-02 §6.3a："**不推送给前端**……前端的视图类型里也没有这个字段"）；pi 的 system 消息（完整的系统提示词，加上 `toolsAdded`）；toolResult 的 `data`。A-01 没有定义面向浏览器的事件视图，§9.4 也没有写 `role=system` 怎么渲染。 | A-02 §6.3a；§1.3 "`@fb/contracts/web` 包含事件信封和事件类型"；H-08 | 定义 `PublicEventView`：gateway 在 REST 和 SSE 出口统一裁剪，去掉 thinking 块，丢弃 `role=system` 的消息（或者只返回 seq 占位，保证序号连续），toolResult 只保留 `{toolCallId, name, isError}`。`@fb/contracts/web` 只导出裁剪后的类型。T06 测试断言公共响应里不会出现 `"thinking"` 和 system 消息的文本 |
| I-5 | 重要 | §3.2 `events.payload jsonb`、`tool_calls.input_sha256` | **jsonb 不保留键的顺序**（会按键长度和字节重新排序）。影响有三处：① D-47 的重放用的是从日志里读回来的 args，它的 `JSON.stringify` 和第一次调用不一样，`input_sha256` 对不上，返回 `IDEMPOTENCY_CONFLICT`，于是退化成写 interrupted，D-47 的方案 A 实际上失效；② A-02 §4.1 和 §6.5 要求"重建后发出的请求和第一次一致"，但 `toolsAdded` 的 schema 和 toolCall 的 args 键序都会变，黄金测试会失败，DeepSeek 的前缀缓存也会失效（D-46 关心的正是这个）。 | D-47 ✅；A-02 §4.1"重放一致性"、§6.5 第 1 条 | `input_sha256` 改用规范化 JSON（递归排序键）计算，写进 contracts；`events.payload` 改成 `json` 类型（保留原文和键序），或者另加一列 `payload_text`。T05 / T08 加一个"键序往返"测试 |
| I-6 | 重要 | §3.2 `user_memories.source_seq bigint NOT NULL`、§3.3 hands 授权、A-02 §5.1 | **hands 拿不到 `source_seq`**。hands 没有 events 的读权限，execute 信封 `{name, input, toolCallId, runId}` 里也没有输入事件的 seq，所以 `save_preference` 写不进这一列（违反 NOT NULL）。 | §3.2 DDL；A-02 §5.1 信封；A-02 §9.2"每一条记忆都记录来源 `{sourceSessionId, sourceEventSeq}`" | 在 execute 信封里加一个 `inputSeq`（harness 从本次运行的 `inputSeqs` 里取最后一条 user.message 的 seq），或者把它放进 hands token 的 claims；字段名和 A-02 统一（`source_seq` 对应 `sourceEventSeq`） |
| I-7 | 重要 | §5.1 emit 第 5、6 步，以及"201"响应 | **批量 emit 的原子性、去重和 seq 分配没有定义清楚**。第 5 步写的是 `last_seq = last_seq + n`，第 6 步说"重复写入返回原来的 seq"。如果一批里有一部分是重复事件，n 是多少？按 n 增加计数器会留下空洞，违反"连续无空洞"。两个 worker 并发写同一个 key 时，唯一索引冲突导致整个事务回滚，之后要不要重试、怎么返回 `deduplicated`？另外，响应固定写成 201，和 §4.1"幂等重放返回 200"不一致。 | §3.2 "seq 每个会话从 1 开始，连续无空洞"；§4.1 | 推荐改成**单事件 emit**（A-02 原本就是一次写一条）。如果保留批量：先在事务里 `SELECT … WHERE idempotency_key = ANY($keys) FOR UPDATE`，n 等于新事件的数量；遇到唯一冲突就整批回滚，再重新执行一遍去重流程；全部是重复事件时返回 200 |
| I-8 | 重要 | §4.2"所有非 GET 请求都要满足三条"、§4.3 登录和退出 | **登录接口无法满足 CSRF 规则**：登录之前 Redis 里还没有会话，`X-CSRF-Token` 没有可以比对的值。文档没有写豁免规则（登录时只检查 Origin 和 Content-Type）。另外，`POST /auth/logout`、`DELETE /profile/memories*` 没有请求体，但规则要求 `Content-Type: application/json`。Fastify 遇到"声明了 JSON 但请求体为空"会直接返回 400（FST_ERR_CTP_EMPTY_JSON_BODY）。 | §4.2 原文；D-08 | 写明：`/auth/login` 豁免 CSRF token，但必须检查 Origin，登录成功后轮换 sid 和 csrf；没有请求体的方法只检查 CSRF 和 Origin，不检查 Content-Type（或者统一要求带 `{}`） |
| I-9 | 重要 | §5.2 失败表"gateway → booking 超时"和"对账任务" | **对账只在 gateway 启动时运行**。如果 booking 已经提交、但 gateway 等它超时返回了 503（gateway 没有崩溃），`booking.confirmed` 就一直写不进去，除非用户重试或者 gateway 重启。这时前端轮询 `GET /quotes/:id` 会显示 booked，但事件日志里没有这条记录：A-02 的投影看不到出票，bookingClaimGuard 会误判，回放历史时也看不到出票卡片。 | §5.2 原文："gateway 启动时运行**对账任务**" | 对账改成周期任务（可以和恢复扫描合并，每 15 到 60 秒一次）；另外，`GET /quotes/:id` 发现"已兑换但没有事件"时，就地补写事件（幂等键 `booking:{quoteId}` 保证只写一次） |
| I-10 | 重要 | §5.3"已知局限"、§7 harness ACL `~lease:*`、§5.1 internal GET | **hands token 局限的描述比实际轻**。harness 对 `lease:*` 有完整的写权限，可以自己 INCR fence、SET lease，所以 fencing 拦不住 harness，它能为**任意**会话（不只是"正在运行的会话"）签出 hands token，进而读取任意用户的机票，为任意用户写报价、出示记录和记忆。另外，`GET /internal/v1/sessions/:id/events` 不需要 fence，所以 harness 能读出所有用户的全部对话，而 harness 是能出网的（D-26 暂时不加白名单）。这些都不能出票（H-02 仍然成立），但 §5.3 和 §12 的说法不准确。 | §5.3 原文"可以为任何正在运行的会话申请 token……签发前必须通过租约 fencing"；D-26 | 至少要在"局限"一节如实写出：harness 等价于"能读所有会话、能以任意用户身份调用 hands 的只读和偏好工具"。可选的加固：签发 token 前检查 `sessions.status IN ('queued','running')`；读接口也要求带 fence |
| I-11 | 重要 | §7 恢复扫描、§9.5、§16.2 X-1/X-3/X-4/X-11 | **接缝状态过期，阈值和 A-02 冲突**。A-01 §7 写的是"超过 90 秒……**具体取值需要 A-02 确认**"、扫描间隔 60 秒；A-02 §16.2 X-11 已经答复：queued 超过 10s、running 超过 45s、间隔 15s。§9.5 写"关联键需要 A-02 确认……见接缝 X-4"，但 A-02 §2.1 已经加了 `messageKey`。 | A-02 §16.2、§12 | 按 A-02 的答复更新 §7、§9.5、§16.2，并把 X-1、X-3、X-4、X-11 移到"已经解决" |
| I-12 | 重要 | §9.4 `agent.guard_violation` 那一行 | **守卫事件的前端渲染规则和 A-02 的字段对不上**：A-01 用 `messageSeq`，取值写成 `replaced` / `regenerated`；A-02 §2.1 用 `messageKey`，取值是 `"regenerate"\|"replaced"\|"stripped"`。A-01 没有处理 `stripped`，前端遇到它不知道怎么渲染。 | A-02 §2.1、§8.4 | 按 A-02 改成用 `messageKey` 关联，取值用 `regenerate` / `replaced` / `stripped`；`stripped` 的处理方式是：只显示落库版本，已经流式显示的文字靠 `delta{reset}` 清掉 |
| I-13 | 重要 | §2.3 凭证矩阵 | **矩阵只列了 4 个服务**，漏了 `migrate`（`fb_owner` 密码）、`postgres`（超级用户密码，以及各角色的初始密码由谁设置）、`redis`（ACL 文件）、`caddy`（应该什么凭证都没有）。`migrate` 用的是 gateway 的镜像，矩阵也没有说明 `fb_owner` 的凭证**不能**挂进 gateway。 | H-07："检查每个容器的环境变量" | 凭证矩阵列出全部 8 个容器；角色密码由 migrate 用 `ALTER ROLE … PASSWORD` 从 secret 文件读取后设置，写进 §3.4 |
| I-14 | 重要 | §13 测试列 | **有几条测试证伪不了**：H-02 少了"harness / hands → gateway:8080 失败"（见 I-2）；H-03 和 H-09 写的是"CI 检查"，但 D-14 只用本地 git，项目里没有 CI，应该改成 `pnpm check` 或 pre-commit hook；H-10 只写了"收尾检查清单"，没有提到 `prompt history/` 必须是原始导出、只脱敏密钥，也没有机器检查（比如提交前扫描 prompt history 里有没有 key）；H-05 写"即使是表的 owner 也不能改或删"，过强（owner 可以 `ALTER TABLE … DISABLE TRIGGER`），应改成"运行时没有任何服务使用 owner"；H-06 整条交给了 A-02，A-01 部分（恢复扫描、对账）没有写对应的测试 | P-01 H-02、H-09、H-10；D-14 | 逐条补上可以执行的检查命令，并写明由哪个任务负责 |
| S-1 | 建议 | §4.6、§5.4、§11 | booking 的错误响应信封没有定义（"404 / 409 以及错误码"）；gateway 怎么把 booking 的 4xx / 5xx 映射成公共错误码，也没有写；确认接口第 2 步"否则 404"用哪个错误码没写；§11 写的"503 `INTERNAL`"和 §4.6 的"`INTERNAL` 500"冲突 | §4.6 原文 | booking 也用 `ApiError` 信封；写一张映射表；新增 `SERVICE_UNAVAILABLE` 503 |
| S-2 | 建议 | §5.3 | hands token 只写了 claims，没有写编码格式（JWS compact？`alg: EdDSA`？要不要 `kid`？），也没写时钟偏差的容忍度。另外，token 是签名、不是加密，harness 其实能读到里面的 uid，"session API 不返回 userId"只是约定，不是隔离 | §5.3 | 写明"JWS compact，EdDSA，Ed25519，包含 kid，leeway 30s"；在 H-04 里注明 uid 对 harness 可见，但不会进入 LLM 上下文 |
| S-3 | 建议 | §4.3 `?cursor` | cursor 的格式和排序键没有写（`GET /sessions` 按 `(updated_at, id)` 排序，但 updated_at 一直在变，翻页时会漏条或者重复） | §3.2 索引 `sessions_user_updated` | cursor 用 base64url 编码的 `{updatedAt,id}`，写明翻页时可能重复，前端按 id 去重；或者历史列表改用 `created_at` 排序 |
| S-4 | 建议 | §7 harness ACL `&sse:*`、§4.4 | harness 能向**任意**会话的 `sse:session:*` 频道发布消息，可以往别的用户的实时画面里塞假的 `agent.delta` 文本，或者假的 status。gateway 怎么处理 `{kind:'evt', seq}` 通知（回数据库读，还是直接转发）也没写。用户退出登录后，已经建立的 SSE 连接仍然会继续推送 | §7 原文 | gateway 按 schema 校验 eph 事件后再转发；`evt` 通知一律回数据库按 seq 读取；退出登录时关闭这个 sid 对应的 SSE 连接 |
| S-5 | 建议 | §3.2 `users`、§4.3 登录 | 请求里的用户名限制是 `string(1..32)`，但 NFKC 规范化之后长度可能变长（比如连字 "ﬀ" 变成 "ff"），超过 32 时会触发 DB 的 CHECK，返回 500 | §3.2 CHECK | 先规范化，再校验长度，超长返回 400 |
| S-6 | 建议 | §3.2 `user_memories`、`memory_deletions` | `key` 没有 CHECK 约束；`memory_deletions.user_id` 没有约束必须等于被删记忆的 user_id | §3.2 | 加 `CHECK (key IN ('home_city','preferred_language'))`；用复合外键 `(memory_id, user_id)` 引用 `user_memories(id, user_id)` |
| S-7 | 建议 | §4.3 转义规则 | 只转义 `<system_event` 和 `<run_context`。`< system_event`（中间带空格）、全角的 `＜system_event`、HTML 实体这些变体，模型同样可能当成标签 | A-02 §13.2 | 匹配规则改成"`<`、可选的空白、可选的 `/`、标签名"，并且先做 NFKC；红队用例覆盖这些变体 |
| S-8 | 建议 | §4.6 末段 | "代码不能重名"和实际情况冲突：`QUOTE_NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`FENCE_STALE` 两张表里都有。而且 `QUOTE_NOT_FOUND` 两边的语义也不同（A-01 是"不属于当前用户"，A-02 §5.3 是"不属于这个 session"） | §4.6、A-02 §5.3 | 改成"同名必须同义"，并统一 `QUOTE_NOT_FOUND` 的判定范围 |
| S-9 | 建议 | 文首、§14.1 | 文首和 §14 没有收录 D-35 到 D-51（尤其是 D-44、D-47、D-51），也没写它们对 A-01 的影响。D-44（默认并行执行工具）意味着 hands 会在**同一个会话里**并发收到多个不同 toolCallId 的调用，A-01 §5.5 只写了同一个 toolCallId 的并发 | decisions.md D-44、D-47 | §14.1 补上这些决策；§5.5 写明 hands 不做会话级串行化，同一个会话里不同 toolCallId 的调用可以并发执行 |
| S-10 | 建议 | §1.2 依赖规则 | harness 允许依赖 `platform`，而 `platform` 依赖 `pg`。即使 harness 不直接 import pg，pg 驱动也会被带进 harness 进程，"harness 没有 pg 驱动"这条规则名不副实 | §1.2 | platform 拆成子入口（`platform/log`、`platform/http`、`platform/pg`、`platform/redis`），harness 禁止依赖 `platform/pg` |
| S-11 | 建议 | §1.2 contracts 那一行 | 写的是"只能依赖 schema 库"，但同一节又说 ID 生成"用 `node:crypto` 自己实现"，前后不一致 | §1.2 | 允许 `@fb/contracts/server` 使用 `node:crypto` |
| S-12 | 建议 | §2.3 `LOCATIONS_DB_SHA256` 那一行 | 这是 contracts 里的常量，不是凭证，也不是环境变量，放在凭证矩阵里容易让人误以为它可以通过配置修改 | §2.3 | 从矩阵里移出，写明"只读 contracts 常量，不接受环境变量覆盖" |
| S-13 | 建议 | §3.2 `tickets.ticket_no` | 8 位 base32 的票号碰撞概率很低，但 UNIQUE 冲突会导致整个出票事务失败，文档没有写重试 | §5.2 | 冲突时在事务里重新生成并重试，最多 3 次 |
| S-14 | 疑问 | §3.2 `CHECK (pg_column_size(payload) <= 65536)` | `pg_column_size` 对已经 TOAST 压缩的值返回的是压缩后的大小，这个 CHECK 不一定能约束原始大小 | Postgres 文档 | 以 gateway 在第 4 步的原始字节数检查为准，DB 层改成 `octet_length(payload::text)`，或者干脆删掉这个 CHECK |
| S-15 | 疑问 | §3.2 `tool_calls` 主键、A-02 §3.7 `msg:tr:{toolCallId}` | 整个设计都假设 DeepSeek 返回的 toolCallId 在一个会话里**跨运行唯一**。如果厂商按序号重复使用 id（有的厂商会这么做），新的工具结果会被当作旧结果去重掉，配对就会损坏（`CONTEXT_CORRUPT`） | A-02 §3.7 | T09 先验证；或者把 key 改成 `{runId}:{toolCallId}` |
| S-16 | 疑问 | §13 H-09 | 文档写"`.npmrc` 加上 pnpm 的 `minimumReleaseAge`"。据我所知，pnpm 的这项设置是写在 `pnpm-workspace.yaml` 里的，R-01 引用的是 npm 风格的 `min-release-age=2`。两者的写法和生效位置需要确认 | R-01 第 54 行 | T00 用实际的 pnpm 版本确认，并写进 `pnpm check` |
| S-17 | 建议 | §4.3 `user.message` 幂等 | 没有写 `idempotency_key` 怎么取（比如 `user:{clientMessageId}`），也没写"text 不同"比较的是转义前还是转义后的文本 | §4.3 | 写明 key 的格式，比较时用转义前的原文 |

---

## 4. 和 A-02 的接缝矛盾清单

| # | 接缝 | A-01 的写法 | A-02 的写法 | 结论和处理 |
|---|---|---|---|---|
| C-1 | `booking.failed` 是否唤醒 | §5.2 暂时按"按门铃"写；§6.3 写成 `queued` | §3.1：不唤醒（D-A14）；§16.3 C-2 | **A-01 要改**（D-51 ✅），见 B-2 |
| C-2 | `sessions.status` 推导 | `booking.failed` 加按门铃 → queued；`run_completed` → idle | §16.3 C-3：只有 `user.message` 会变成 queued | A-01 要改；另外还要处理 B-3 的"run_completed 时还有待处理输入" |
| C-3 | 恢复扫描的阈值 | 90s，间隔 60s，"需要 A-02 确认" | queued 10s / running 45s / 间隔 15s（§16.2 X-11，§12） | A-01 按 A-02 改 |
| C-4 | delta 和最终消息的关联键 | §9.5"需要 A-02 确认……见 X-4" | §2.1 `agent.message` 已经带 `messageKey`，§3.7 定了格式 | A-01 改成按 messageKey 精确替换 |
| C-5 | X-1 / X-3 状态 | §16.2 仍然待确认 | §16.2 已经同意 | A-01 移到"已解决" |
| C-6 | `agent.guard_violation` 的字段 | `messageSeq`；`replaced` / `regenerated` | `messageKey`；`regenerate` / `replaced` / `stripped` | A-01 按 A-02 改（I-12） |
| C-7 | `replaced` 时原消息有没有落库 | §9.4 假设落库了，"用后面紧跟的那条模板消息代替它显示" | §8.4 第 4 步写"这条也不落库"，但 §4.2 规则 6 又写"被 replaced 标记的消息：用模板文本代替"（A-02 内部就自相矛盾） | **疑问**：需要父会话裁定，然后两边统一。推荐"不落库"，那么前端对 `replaced` 什么都不用做 |
| C-8 | `booking.confirmed` 的 payload | `{ quoteId, ticketId, ticketNo, summary }` | §2.3 是 `{ quoteId, ticketId, summary }`（没有 ticketNo），§4.2 规则 4 的示例里又有 ticketNo | 以 A-01 为准，A-02 §2.3 补上 ticketNo；`TicketSummary` 双方都说"由 contracts 冻结"，目前**没有任何一方写出最终定义**，需要在契约 v1 里补上（numberGuard 依赖其中的 display 字段） |
| C-9 | `meta.template` 放在哪 | §6.3："这是 payload 里的字段" | §12："在 `content` 之外附加 `meta`"，但 §2.1 的 payload 定义里没有 `meta` | 契约 v1 统一放在 `payload.meta.template`，A-02 §2.1 补上这个字段 |
| C-10 | thinking 块和 system 消息能不能给前端看 | 公共 API 原样返回 EventEnvelope | §6.3a："不推送给前端" | A-01 增加公共视图并裁剪（I-4） |
| C-11 | 记忆的来源 seq | `user_memories.source_seq NOT NULL` | 要求 `sourceEventSeq`，但 execute 信封里没有这个字段 | 信封里加 `inputSeq`，或者放进 token claims（I-6） |
| C-12 | 重放一致性和 jsonb | `events.payload jsonb`，`input_sha256` 没有规定规范化 | D-47 重放、§4.1 和 §6.5 的请求逐字节一致 | 存储格式或哈希规则要改（I-5） |
| C-13 | 工具执行的并发模式 | 只写了同一个 toolCallId 的并发 | §6.2 仍然写"`sequential`（**待 D-44**）"，但 D-44 已经 ✅ 定为默认并行 | 两边都要同步 D-44；A-01 §5.5 写明同一个会话里不同 toolCallId 可以并发（S-9） |
| C-14 | fence 的取号顺序 | §5.1 校验 `X-Lease-Fence >= GET lease:fence` | §3.2 先 `INCR fence`，再 `SET NX lease`。抢锁失败的 worker 也会把 fence 加 1，导致正在持有租约的 worker 收到 FENCE_STALE 后停下，要等租约过期（30s）加上恢复扫描（45s）才能恢复 | **疑问 / 建议**：jobId 去重让这种情况很少发生，但 BullMQ 把停滞任务重新投递时会触发。建议 A-02 改成 SET NX 成功之后再 INCR |
| C-15 | 自己按门铃 | §7 jobId 固定为 `wake-{sid}` | §3.5 在 job 还没结束时自己按门铃 | 同一个 jobId 会被去重（B-3），双方要一起改 |
| C-16 | `session.created` 事件 | §6.3：seq 1，system | §4.2 规则 8 的"不参与投影"列表里没有它 | A-02 补上；或者 A-01 不再写这个事件（见 §5 简化建议） |
| C-17 | execute 的 trace 头 | §5.5 和 §8：`traceparent` 加 `X-Trace-Id` | §5.1 只写了 `traceparent`（"最终由父会话在 X-9 定"） | X-9 已经裁定，A-02 §5.1 补上 `X-Trace-Id`。platform 的客户端会自动加，实际影响很小 |
| C-18 | 一致的部分（核对通过） | `quote.offered {runId, quoteId, toolCallId}`；Quote 的字段（quoteId、legs、transferCities、totalDistanceKm、priceCents、display.legs[] / totalDistanceKm / priceUsd、dataSha256、createdAt）；WakeJob `{sessionId, traceparent}`，jobId `wake-`；session API 的形状（getEvents 升序、emit 带 fence 和幂等键、409 FENCE_STALE、去重返回原来的 seq）；hands token（Ed25519，5 分钟，401 时重新申请）；`tool_calls` 放在 Postgres、只能插入、和副作用在同一个事务里；记忆只插入、加墓碑、不回退到旧值；ephemeral 事件的类型（`agent.delta` / `tool_status` / `status`）和 payload；harness 写事件的类型白名单 | 同左 | 一致 |

---

## 5. 过度设计和简化建议（都不违反已确认的决策）

| # | 现在的设计 | 为什么可以简化 | 建议 |
|---|---|---|---|
| O-1 | `quote_redemptions` 和 `tickets` 两张表，都是只能插入 | `tickets.quote_id` 已经是 `UNIQUE`，单独这一条就能保证"每个报价只能出一张票"。两张表在同一个事务里写，多了一张表、一套授权和一条 grep 检查规则 | 删掉 `quote_redemptions`，改成 `INSERT INTO tickets … ON CONFLICT (quote_id) DO NOTHING`。H-02 的"只能用一次"不受影响 |
| O-2 | 批量 emit（1..20 条） | A-02 本来就是一次写一条；批量带来了 I-7 里那些去重和 seq 的难题 | 改成单事件 emit；D-44 并行执行时，toolResult 仍然按原始顺序一条条写 |
| O-3 | 确认请求体里的 `{ sessionId }` 加上 `QUOTE_SESSION_MISMATCH` | 报价本来就绑定在一个会话上（`quotes.session_id`），由 booking 从报价里读出会话即可 | 请求体为空（或者 `{}`），少一个错误码。D-10 的"绑定 session"不受影响 |
| O-4 | harness、hands、booking 都按 1..N 副本设计 | 面试项目单机部署，1 个副本就够了。租约和 fencing 是 D-04 要求的，必须保留，但没必要为多副本 hands 和 booking 做额外的论证和测试 | 部署时每个服务 1 个副本，文档里说明"可以横向扩展" |
| O-5 | `EphemeralEnvelope.refSeq`、`events.schema_version`、`ticket_no` 和 `id` 两套标识 | `refSeq` 没有任何使用方；schema_version 在 v1 是常量；票号可以直接从 ticket id 派生 | 删掉 `refSeq`；`ticket_no` 改成 `'OA-' + id 的后 8 位`，省掉碰撞重试 |
| O-6 | 启动时对账、每 60 秒恢复扫描、Redis 丢失时重置 fence，三个后台任务 | 都在 gateway 里，都是周期性扫描 | 合并成一个 `gateway-sweeper`，每 15 秒运行一次，依次做三件事（同时解决 I-3、I-9、C-3） |
| O-7 | 自己实现 ULID | ID 只需要唯一，不需要按时间排序（排序都靠 `created_at` 和 seq） | `q_` 加上 26 位随机 base32（`crypto.randomBytes`），CHECK 规则不用改 |
| O-8 | `session.created` 事件（seq 1） | 不参与投影，前端也不显示，locale 已经存在 `sessions` 表里 | 去掉这个事件（顺便消除 C-16）；如果要保留审计记录，就在 A-02 里写明投影时跳过 |
| 保留 | 两个数据库网络、Ed25519 签名、`max_fence_seen`、`memory_deletions`、contracts 拆成 web 和 server 两个入口、OTel 空实现 | 分别对应 D-07（hands 在网络上到不了 booking）、"hands 不应该能签发 token"、D-34、D-32、R-U1、D-11，都是已经确认的决策，或者成本很低的必要隔离 | 不简化 |

---

## 6. 附：本次核对过、没有发现问题的地方（避免重复审查）

- D-06、D-07：booking 是独立容器，只接入 `bk` 和 `db_booking` 两个网络；harness 不在 bk 里，也没有 booking token 和数据库凭证；工具里没有下单类工具（A-02 §13.1）；booking 的三项校验（报价归属、已出示、只能用一次）都在一个事务里完成，主键冲突时返回 alreadyBooked。和 H-02 的唯一缺口是 I-2。
- D-08 和 H-04：公共请求体里没有 userId；booking 收到的 userId 来自 gateway 解析的 cookie；hands 的身份来自 token；别人的资源一律返回 404。
- D-10：booking 不检查报价是否过期，和"报价不过期"一致。P-01 H-02 原文里的"有效期"已经被 D-10 覆盖。
- D-14：部署时在虚拟机上本地构建，不使用远程仓库和镜像仓库。
- D-24：ajv 的 `coerceTypes:false, removeAdditional:false, useDefaults:false` 写死在 platform 的工厂函数里；查询参数用"字符串 + 正则"再显式转换；测试列有对应的用例。
- D-26：`EGRESS_PROXY_URL` 为空时直连，代理逻辑收在适配层（§2.5）。
- D-32：记忆只插入，用墓碑加删除记录；"下一步"一节引用了人的原话。
- D-39：出票成功不唤醒 harness；系统出票卡片的数据来自 API；E2E 第 8 条断言出票后没有新的 `run_started`。
- R-U1：§1.3 的目录归属表加上 contracts 的两个入口，前端只能用 `@fb/contracts/web`；T12 拆成两个会话（A-03 第 62、63 行）。和 A-03 §3 一致。
- 数据库授权：fb_hands 对 tickets 和 quote_redemptions 只有 SELECT，所以不能出票；fb_gateway 对 events 只有 SELECT 和 INSERT；harness 没有数据库角色；外键检查由表的 owner 执行，所以只有 INSERT 权限的角色写带外键的行也没有问题。
