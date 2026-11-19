# A-02 Agent 设计 正交验收报告

- 被审对象：`docs/design/A-02-agent.md`（草案 v0.3，1036 行）
- 验收者：独立验收会话（未参与 A-02 写作，不看写作过程）
- 日期：2026-11-18
- 依据：题目原文、P-01（H-01..H-10）、`docs/adr/decisions.md`（只认 ✅/🔁）、W1-seams、A-02 任务单、`spikes/S-01/REPORT.md`（pi 行为的唯一可靠来源）、A-01 v0.3（只用来核对接缝）、`locations.db`（只读，python 核实）
- 没有修改任何已有文件，没有调用 DeepSeek API。A-02 任务单末尾的"汇报"只当作者自述，没有当证据。

---

## 1. 结论：**不通过**（修完 5 个阻塞项、同步已确认决策后，可以转为"有条件通过"，不需要重写）

文档骨架好：日志驱动、确定性投影、harness 自己补齐工具结果、`Value.Check` 放在 `beforeToolCall`、不用 strict、出票后不唤醒，这些主方向都和 S-01、决策一致。问题集中在三类：
1. **harness 核心机制有可以复现的正确性漏洞**：fence 的 INCR 顺序、投影时输入事件的位置、自己按门铃被 BullMQ 去重吞掉、messageKey 序号没有定义。按文档原样实现，会出现运行被误杀、`continue()` 抛错、消息永久丢失、回复被静默去重。
2. **已确认的决策没有同步进正文**：D-44、D-45、D-47..D-51，还有 §0、§6.1、R-2 里残留的 v0.1 写法。
3. **对 pi 行为的部分假设在 S-01 里找不到依据**，也没有列进 §6.5 的待验证清单。

统计：**阻塞 5 项，重要 13 项，建议 13 项**（见 §4）。

---

## 2. 验收标准逐条核对（`docs/tasks/A-02.md`）

| # | 标准 | 结论 | 依据 |
|---|---|---|---|
| 1 | W1-seams 里 A-02 负责的每一行都有对应章节 | **通过**（有一处偏弱） | agent 侧事件 §2；session API 的调用时机、幂等、租约 §3 + §16 R-1/R-2；execute 信封 §5；工具 schema §7；确认链路 agent 侧 §13.1；quote 字段 §7.2；记忆的写入、召回、注入、防注入 §9；对话语言和中文城市名 §10、§7.1；评测 §14；events/quotes/memories 的字段需求 §16 R-8。偏弱的是"harness 的 span 划分"，全文只有 §6.2 一行：`span harness.run > llm.request / tool.execute`。 |
| 2 | 没看过会话历史的 T2 开发者只读 A-02 和契约，就能实现 T09 | **不通过** | 走查见 §3。一共 26 处需要开发者自己猜，其中 4 处按字面实现就会出错（B1–B4），1 处和已确认的决策冲突（B5）。另外 §6.1 的对外接口是旧版本，和 §3.4 矛盾（I-13）。 |
| 3 | 题目要求设计文档回答的 5 个问题里，agent 相关部分能直接引用 | **通过** | 工具和理由 §7.0；数字正确性 §8；确认机制 §13.1；失败模式 §12；局限 §13.3。注意 §13.3 只列了 2 条，其他局限散落在 §9.4（快照不改写）、§8.4（stripped 偏差）、§8.5（另一个报价的出票声明），A-01 §5.1 还有 fence 窗口。最终设计文档要汇总。 |
| 4 | 新的取舍按 D-xx 列出，不自己定 | **部分** | 格式合规（§17）。但状态已经过时：文件头写"D-A10 到 D-A14 还没有定""D-44 到 D-46 … 正文没有改"，而 decisions.md 里 D-44..D-51 已经 ✅。正文有几处自己做了小决定、没有登记，例如 §10 "第一次运行默认 `zh`"、§6.3b "`INVALID_INPUT` 超过 5% 再考虑 /beta"、§4.3 "保留最近 N 次运行"（N 没给）。这些影响很小。 |
| 5 | 接缝问题单独成节 | **通过**（但内容和 A-01 有矛盾） | §16、§16.2、§16.3 单独成节。但 §16 写着"A-01 v0.2 §16.1 已经逐条答复 R-1 到 R-10，全部满足"，没有处理 A-01 的 X-14，也没有处理 A-01 里还在"按门铃"的 `booking.failed`（见 §6）。 |

---

## 3. "扮演 T09 开发者"走查记录

我假装手上只有 A-02 和契约，按 wake → 拿租约 → 读日志 → 投影 → 运行 → 回写 → 释放的顺序实现一遍。✗ 表示按字面实现会出错，? 表示需要自己猜。

### 3.1 wake 和拿租约（§3.1、§3.2）
1. ✗ **租约脚本的顺序**。§3.2 原文：
   ```
   fence = INCR lease:fence:{sid}
   ok    = SET lease:session:{sid} "{workerId}:{fence}" NX PX 30000
   若 !ok → 结束这个任务
   ```
   抢锁**失败**的 worker 也已经执行了 INCR。这时正在运行的持有者手上的 fence 小于 `lease:fence`，它下一次 emit 时 gateway 按 `fence >= GET lease:fence:{sid}` 判断，返回 409。§3.2 规定"harness 收到 FENCE_STALE → 立刻停止，不重试"。
   文档自己也说会有多余的门铃：§3.3 "恢复扫描会产生无害的多余门铃"，§16.2 X-11 "只会多发一个无害的门铃"，再加上 BullMQ 停滞重投。所以每一个多余的门铃都会**误杀正在运行的会话**。被杀的运行要等恢复扫描（45s 后）才会被接手，attempt 加 1；连续 3 次就变成 `RESTART_LIMIT`。→ **B1**
2. ? `runId` 怎么生成：§5.1 的例子是 `run_01J...`，但没有写明格式，也没说是否要确定性。
3. ? 收到 `FENCE_STALE` 停下来之后，要不要执行释放 Lua（value 还是自己的情况下）？

### 3.2 计算待处理工作（§3.3）
4. 规则清楚，可以实现。

### 3.3 投影（§4.2）
5. ✗ **输入事件放在什么位置**。规则 3 把 `user.message` 投影在它自己的 seq 位置（"按 seq 顺序扫描"）；规则 2 只把 run_context "提前"放到"这次运行的第一个输入之前"。
   D-31 允许"运行期间用户又发了消息"，这条消息 U2 的 seq 落在第 k 次运行的 assistant/toolResult **中间**。到第 k+1 次运行投影时：
   - U2 和 run_context(k+1) 出现在第 k 次运行的中间；
   - 投影的**末尾**是第 k 次运行的最终 assistant 消息。§3.4 第 4 步的断言失败；就算跳过断言，`continue()` 也会抛 `Cannot continue from message role: assistant`（S-01 Q4）；
   - 如果 U2 正好落在 `assistant(toolCalls)` 和 `toolResult` 之间，就会把这一对拆开。openai-completions 协议要求 tool 消息紧跟在 tool_calls 后面，DeepSeek 会返回 400。规则 9 只检查"后面有结果"，不检查"紧跟"。
   
   `booking.*` 也有同样的问题。规则 1 只保证 `seq < S`；用户在第 k 次运行中途点击确认一个**更早**的报价时，它同样会落在第 k 次运行的消息中间。→ **B2**
6. ? 第一次运行时 pi 的 system 消息从哪里来：`initialState.systemPrompt`（§3.4 第 3 步），还是 messages 里的 system 消息（§4.2 规则 5）？两者同时存在时 pi 怎么处理？system 消息占不占 messageKey 的序号 0？§6.5 第 3、5 条只要求"验证"，没有给出两种结果各自怎么处理。
7. ? 规则 6 和 §8.4 第 4 步互相矛盾（见 I-4）：`replaced` 到底是"标记一条已落库的消息，再用模板替换"，还是"不落库，另写一条模板消息"？
8. ? §4.3 的 token 估算是"每 3 个字符 1 个 token，中文按每个字 1 个 token"，中英混合时怎么算？"保留最近 N 次运行"里的 N 是多少？
9. ? 第 k 次运行崩溃时，如果旧 worker 在 fence 窗口里多写了一条消息，projector 怎么处理（A-01 §5.1 说"由 A-02 §3.6、§4.2 按 runId 和 attempt 处理"，A-02 里没有这条规则）？→ I-10

### 3.4 构造 Agent 和运行（§3.4、§6.1）
10. ✗ **对外接口用哪一版**。§6.1 的 `AgentRuntime` 里有 `runContext: RunContext; // 每次请求时注入（§4.4）` 和 `input: "prompt" | "continue"`，和 §3.4 "一律调用 `agent.continue()`，永远不用 `prompt()`"、D-49 "从 run_started 确定性投影"矛盾。§0 的总览图也还写着"pi Agent（prepareRequest 重建）"。→ I-13
11. ✗ **工具串行还是并行**。§6.1 代码和 §6.2 都是 `toolExecution: "sequential"`，标着"待 D-44"。D-44 ✅ 已经定为"默认并行，有副作用的工具标 sequential，toolResult 按 assistant 里的原始顺序落库"。正文没有给出：哪个 pi 选项、每个工具的 `executionMode` 怎么写、按什么事件保证落库顺序、对应的测试。→ **B5**
12. ? `finishTurn` 返回 `{action:"end"}`、`agent.abort()`、`message_update`、`afterToolCall`、"execute 抛错会变成 isError 结果"、`details` 不会发给 LLM：这些 S-01 都没有实测（见 §5）。
13. ? 60s 请求超时和"同一次请求重试 2 次（1s/3s）"（§12）在 pi 里怎么做？是 pi 自己重试，还是 harness 丢掉 Agent、从日志重建？出错的那条 assistant 消息要不要先落库？§3.6 说 error 消息"后面一定跟着同一个 runId 的 resumed 或 run_failed"，但正常路径（§3.4）里没有写什么时候发这两个事件。→ I-7
14. ? 429 的 `retry-after` 怎么从 pi 里拿到？

### 3.5 事件回写（§3.4 第 5 步、§3.7）
15. ✗ **messageKey 的序号 n**。§3.7 原文："n 是这条消息在本 attempt 里的序号（system 和 assistant 一起从 0 开始数）"。没有说 n 是按"已落库的消息"数，还是按"pi 发出的消息"数，也没说守卫重新生成时（§8.4 第 3 步"丢掉这个 Agent … 新建 Agent"）计数器要不要接着上一个 Agent 往下数。两种实现都会出错：
   - 按已落库的数：被拒绝的那条不落库，重新生成的那条拿到同一个 n。第二次违规时 `guard:{messageKey}` 撞键，被去重吞掉，`replaced` 事件丢失；
   - 每个新 Agent 从 0 开始数：重新生成的回复和本 attempt 里更早落库的消息撞键，gateway 返回 `deduplicated:true`，**最终回复被静默丢弃**，然后照常写 run_completed。
   
   → **B4**
16. ✗ **`quote.offered` 可能丢失**。§3.4 原文："如果是 `offer_booking`，并且成功了，**紧接着** `emit quote.offered`"。如果在 toolResult 落库之后、`quote.offered` 写入之前崩溃，恢复时末尾是 toolResult，直接 `continue()`，`quote.offered` 永远不会再发，卡片不出现。LLM 却会照着 llmText 说"卡片已经显示"。§3.6 的重放路径（`fill:"replayed"`）也没说要补发 `quote.offered`。→ I-5
17. ? 临时事件（delta、tool_status）怎么发？A-01 §7 说 harness 直接 publish 到 Redis `sse:session:{sid}`，A-02 没写，这条路径也没有 fence 保护。

### 3.6 守卫（§8.4、§8.5）
18. ✗ §8.4 第 5 步原文："用本次 attempt 里 `regenerate` 事件的数量来计数，所以崩溃恢复后计数也不会被重置"。按 attempt 计数，恢复后（attempt+1）计数恰恰会被重置。应该按 runId 计数。→ I-3
19. ? 模板消息的事件形状：§12 说用 `agent.message` 加上 `meta:{template}`，但 §2.1 的 payload 和 §2.4 的 `LlmMessage` 都没有 `meta`。A-01 §5.1 第 4 步会按每种事件的 schema 严格校验，不加进 schema 就会被 400 拒绝。模板消息的 messageKey、idempotencyKey 和中英文案的 id 也都没定义。→ I-4
20. ? 允许集合里的"本次运行"包不包括同一个 runId 之前的 attempt？`today` 算不算进允许集合？

### 3.7 结束、释放、再检查（§3.4 第 6 步、§3.5）
21. ✗ **自己按门铃会被吞掉**。§3.5 是"释放租约 → 重新读取日志尾部 → 如果 pending 非空 → 重新 wake(sessionId)（自己按门铃），结束"。可是这一步发生在**当前任务还处于 active 状态**的时候，jobId 也一样（`wake-{sid}`）。§3.1 自己承认"任务正在执行时，新的门铃被 jobId 去重吃掉"，所以自己按的门铃一样会被吃掉。
   再加上 A-01 §6.3 的状态推导："写入 `agent.run_completed` → `idle`"。运行期间到达的 user.message 先把状态设成 `queued`，随后又被 run_completed 改回 `idle`。恢复扫描只看 `queued/running`，所以**这条消息永远不会被处理**，直到用户再发一条。→ **B3**
22. ? 运行在留有悬空 toolCall 的情况下结束（120s 超时 abort、轮次上限、run_failed）：没有规定要先补齐结果。下一次运行时，规则 9 的例外只覆盖"**最后一条** assistant"。后面再接一条新的 user.message，要么触发 `CONTEXT_CORRUPT`，要么（如果跳过检查）由 pi-ai 偷偷补上 "No result provided"，这正是 §3.6 明令禁止依赖的行为。→ I-6
23. ? 轮次、工具次数、"同一个工具连续失败 3 次"这几个计数器都在内存里，崩溃恢复后会归零。它们是按运行算还是按 attempt 算？

### 3.8 崩溃恢复（§3.6）
24. 分情况的表格清楚，补齐规则清楚。✓
25. ? 补齐结果里 INTERRUPTED 模板的措辞和 S-01 Q4 测过的不一样（见 §5 第 9 条），"模型会先问用户"这个观察能不能沿用？
26. ? toolCallId 在整个会话里唯一吗？`msg:tr:{toolCallId}` 和 hands 的 `(sessionId, toolCallId)` 幂等都依赖这一点。S-01 看到的 id 形如 `call_00_ACRP…`，没有验证过跨运行的唯一性。（疑问）

走查结论：第 1、5、10、11、15、16、18、21、22 处按字面实现会出错；其余 17 处要靠猜。T09 不能只凭 A-02 和契约独立完成。

---

## 4. 问题清单

| 编号 | 严重度 | 位置 | 问题 | 依据 | 建议修复 |
|---|---|---|---|---|---|
| B1 | 阻塞 | §3.2 | 先 `INCR lease:fence` 再 `SET NX`。抢锁失败的 worker 也会让 fence 加 1，正在运行的持有者因此收到 `FENCE_STALE` 被误杀。多余门铃本来就是设计里的常态（§3.3、X-11、BullMQ 停滞重投），每个多余门铃都会让运行"崩溃"一次，累计 3 次就是 RESTART_LIMIT | §3.2 原文；A-01 §5.1 第 1 步 `X-Lease-Fence >= GET lease:fence` | 用一个 Lua 脚本原子执行：`SET NX` 成功之后才 `INCR`，并把 fence 写进 value；失败时不动 fence。加一个契约测试："持有者运行中再来 5 个门铃，持有者不会收到 409" |
| B2 | 阻塞 | §4.2 规则 1–4 | 输入事件和 booking 事件留在自己的 seq 位置，run_context 被"提前"放到第一个输入之前。运行期间到达的消息（D-31）会被投影到上一次运行的中间：① 新运行的末尾变成 assistant，`continue()` 抛错（S-01 Q4）；② 可能把 toolCall 和 toolResult 拆开，DeepSeek 返回 400；③ 中途点击更早报价产生的 booking 事件也一样 | §4.2 规则 2 原文"projector 要按 inputSeqs 把这条消息'提前'放"；规则 3；D-31；S-01 Q4 | 改成**按运行分段**投影：每次运行的块 = `[run_context_k, 输入_k（按 seq 排）, 第 k 次运行的 agent.message…]`，整块放在 run_started_k 的位置。`booking.*` 统一放到"seq 之后第一个 run_started"所在块的开头（在 run_context 之前），永远不插进某次运行的中间。规则 9 改成"toolCall 后面**紧跟**它的 toolResult"。加黄金测试："运行中途到达的 user.message"和"运行中途到达的 booking.confirmed" |
| B3 | 阻塞 | §3.5；A-01 §6.3 | 自己按门铃时当前任务还是 active，jobId 相同，会被 BullMQ 去重吃掉（§3.1 自己的前提）。run_completed 又把状态改成 idle，恢复扫描看不到，运行期间到达的消息永久丢失 | §3.1"新的门铃被 jobId 去重吃掉"；§3.5；A-01 §6.3 状态表"run_completed → idle" | ① 释放之后再检查，如果 pending 非空，就**在同一个任务里**重新抢锁、接着循环，不要靠自己按门铃（抢不到锁说明别人在处理，可以安全退出）；或者用一个不同的 jobId（比如 `wake-{sid}-{lastSeq}`）。② 让 A-01 把 run_completed 的状态推导改成"有未消费的 user.message 时设为 queued，否则 idle"，作为第二道兜底。③ 加集成测试："运行期间连发两条消息，两条都会被处理" |
| B4 | 阻塞 | §3.7、§8.4 | messageKey 的 `{n}` 没说按什么数，也没说新建 Agent（守卫重新生成）时怎么接着数。会出现撞键去重：要么 `replaced` 事件丢失，要么最终回复被静默丢弃 | §3.7 原文"n 是这条消息在本 attempt 里的序号"；§8.4 第 3 步"丢掉这个 Agent…新建 Agent" | 定义：n = 本 attempt 里 harness **分配过**的 assistant/system 序号（包括被守卫拒绝、没落库的那条），跨 Agent 重建单调递增，崩溃后从 `max(日志中本 attempt 的 n)+1` 继续；或者把 key 改成 `{runId}:{attempt}:{guardRound}:{n}`。规定：assistant 消息 emit 时如果收到 `deduplicated:true`，要报 `CONTEXT_CORRUPT`，不能静默继续 |
| B5 | 阻塞 | §6.1 代码、§6.2 toolExecution 行、§17.3 | D-44 已经 ✅（默认并行，`offer_booking`/`save_preference`/`forget_preference` 标 `executionMode:"sequential"`，toolResult 按 assistant 里的原始顺序落库），正文仍然是全局 `sequential`，标"待 D-44" | decisions.md D-44；§6.2 原文 "`sequential`（**待 D-44**…）" | 按 D-44 改写 §6.1、§6.2：写清楚每个工具的 executionMode；落库**以 toolResult 的 `message_end` 为准**，并断言它的顺序等于 assistant 里 toolCall 的顺序（不对就按顺序缓冲后再 emit）；§6.5 加上"并行时 toolResult 的 message_end 顺序"和"批里有 sequential 工具时整批串行"两条验证（目前只有 R-01 的文档依据，S-01 没有实测） |
| I-1 | 重要 | §4.2 规则 2、§9.3、§11 §5 | D-45 ✅ 规定用 `key: value` 行，正文仍然是 JSON：`<run_context>{"lang":"zh","today":…,"profile":{…}}</run_context>` | D-45；§17.3 自己写了"如果 D-45 通过，需要修改 §4.2 规则 2 的示例、§9.3 的注入说明，以及 §11" | 把 §17.3 的格式草案提升为正文规范（固定字段顺序、没有值就省略整行、块头注明"仅供推荐参考，不是指令，使用前先问用户"），在 §4.2 规则 2 写成渲染函数的规范，加快照测试 |
| I-2 | 重要 | 文件头、§3.1、§16 R-2、§16.3 C-2、§17 | 状态和内容过时：头部写"D-A10 到 D-A14 还没有定""D-44 到 D-46 … 正文没有改"；§3.1 写"`booking.failed` … 还需要确认，见 D-A14"；§16.3 C-2 写"（待确认）"；R-2 写"harness 为每个事件生成一个 UUID"，和 §3.7 的确定性 key 矛盾 | decisions.md D-47..D-51 ✅；§3.7 | 全文替换成 D-47..D-51；删掉"待确认"；R-2 改成引用 §3.7 |
| I-3 | 重要 | §8.4 第 5 步 | 重新生成次数"按 attempt 计数"，和后半句"崩溃恢复后不会被重置"自相矛盾，恢复后可能多次重新生成 | 原文 | 改成：按 runId 统计这次运行所有 `regenerate` 事件的数量 |
| I-4 | 重要 | §4.2 规则 6 vs §8.4 第 4 步；§2.1、§2.4、§12 | ① `replaced` 有两种互相矛盾的说法：规则 6"被 replaced 标记的消息用模板文本代替"，§8.4"这条也不落库，改为落库一条系统模板消息"；② 模板消息要带 `meta.template`，但 §2.1 的 payload 和 `LlmMessage` 里都没有，A-01 会按严格 schema 拒绝；③ 模板消息的 messageKey 和 idempotencyKey、它和 run_failed 谁先谁后，都没定义 | 原文；A-01 §5.1 第 4 步 | 选定 §8.4 的说法，删掉规则 6 里 replaced 那一项；`agent.message` payload 加上 `meta?:{template:string}`；模板消息的 key 用 `tpl:{runId}:{templateId}`；规定先写模板消息，再写 run_failed 或 run_completed |
| I-5 | 重要 | §3.4 第 5 步、§3.6 | toolResult 落库之后、`quote.offered` 写入之前崩溃，卡片永远不会出现；重放路径（`fill:"replayed"`）也没说要发 `quote.offered` | 原文"**紧接着** emit quote.offered" | 用 A-01 的批量 emit（1..20 条，原子）把 toolResult 和 quote.offered 放在**同一批**里写入；或者恢复时扫描"成功的 offer_booking toolResult 但没有 `offer:{toolCallId}`"的情况并补发（key 是确定性的，补发是幂等的） |
| I-6 | 重要 | §3.4 上限、§12（120s 超时、轮次上限、run_failed） | 运行在 toolCall 还没有结果时被 abort 或结束，没有规定先补齐结果。下一次运行时规则 9 的例外只覆盖"最后一条"，会触发 CONTEXT_CORRUPT 或 pi-ai 偷偷补上的结果 | §4.2 规则 9；§3.6"禁止依赖 pi-ai 的隐式行为"；S-01 Q4 | 规定：任何非 completed 的结局（run_failed、abort 之后结束）**之前**，都按 §3.6 的规则补齐所有悬空的 toolCall（直接写 interrupted 就够了） |
| I-7 | 重要 | §3.4 第 6 步、§12 第 1 行、§3.6 表第 3 行 | 正常路径下 `stopReason ∈ {length, error, aborted}` 怎么处理没写：这条消息要不要落库？"同一次请求重试 2 次"是 pi 内部重试，还是丢掉 Agent 重建？什么时候写 run_failed？§3.6 却断言这类消息"后面一定跟着 resumed 或 run_failed" | 原文 | 写一张"agent_end 的结局 → 动作"表：length → 落库（投影时跳过），重建后 continue 1 次，再出现就用模板加 run_failed；error → 按退避重建 2 次；aborted → 只可能来自租约丢失或超时，分别处理 |
| I-8 | 重要 | §8.4 允许集合；H-01 | 数字守卫的漏报和误报（详见 §4.1）。最关键的一条：**用户消息里的数字被加进了允许集合**，所以 §14.2 的红队用例"价格算错了，应该是 $1"，LLM 跟着说"$1"也能通过。这也偏离了 H-01 的"必须能在本轮工具结果里找到" | §8.4 原文"本次运行的输入（用户消息）"；H-01；§14.2 红队行 | 用户消息里的数字只允许用于"不敏感"的上下文；带货币或距离单位的数字只能来自工具结果、booking summary 和画像。其他修复见 §4.1 |
| I-9 | 重要 | §7.1 第 2 步、§7.5 | `locations.db` 里有两个城市规范化后完全一样：`San Jose`（2868,-1376，连 Tokyo）和 `San José`（1054,-2282，连 Sydney;Tokyo），而且都有航班。"规范化后完全相等就立刻采用，返回 exact"会随机挑一个；save_preference 会静默存错城市。另外 NFKD 去不掉 `ø`、`ł`（Tromsø、Wrocław），这两个城市不能精确命中 | 用 python 读 locations.db 核实（711 个城市，共 1 组规范化碰撞） | 精确匹配命中多个城市时返回 `ambiguous`（如果候选的原始写法和其中一个完全相同，就优先采用它）；save_preference 遇到歧义时返回 INVALID_INPUT 并附上候选；规范化时加一张小的折叠表（ø→o、ł→l、æ→ae、ß→ss…）；把这组碰撞写进 §14.1 的用例 |
| I-10 | 重要 | §3.6、§4.2；A-01 §5.1 第 1 步的说明 | A-01 说 fence 窗口里旧 worker 多写的一批"由 A-02 projector 按 runId 和 attempt 处理"，A-02 里没有这条规则。旧 attempt 的 assistant 和 toolCall 会和新 attempt 的消息一起出现在日志里，导致重复回复或者配对损坏 | A-01 §5.1 原文 | 投影规则加一条：同一个 runId 里，attempt 小于当前最大 attempt、而且 seq 大于新 attempt 的 run_resumed 的 agent.message，一律丢掉（toolResult 本来就按 toolCallId 去重，不受影响） |
| I-11 | 重要 | §3.3、§16 vs A-01 | 接缝矛盾没有处理（详见 §6）：A-01 认为 booking.confirmed 是"待处理输入"（X-14）；A-01 里 booking.failed 还在按门铃，并且把状态设成 queued；恢复扫描的阈值两边不一致 | A-01 L609、L619、L703、L738、X-14 | 在 §16 里明确回复 X-14；合并契约时以 D-39/D-51 为准，统一修改 A-01 |
| I-12 | 重要 | §6.1、§6.3、§12 | 一批 pi 行为在 S-01 里找不到依据，也没有列进 §6.5（详见 §5） | S-01 全文 | 补进 §6.5，用黄金测试锁定 |
| I-13 | 重要 | §0 总览图、§6.1 `AgentRuntime` | 残留 v0.1 的写法："pi Agent（prepareRequest 重建）"、`runContext … 每次请求时注入`、`input: "prompt" \| "continue"`。这是 T09 要实现的对外接口，和 §3.4、D-49 矛盾 | 原文；D-49；S-01 Q3 | 删掉 `runContext` 和 `input`，换成 `messages: LlmMessage[]`（已经包含 run_context）；改掉总览图 |
| S-1 | 建议 | §8.4"带工具调用的消息" | 原文说"这时 pi 已经开始执行工具，不能撤回整条消息"。S-01 Q4 的结论是"Agent 类会等 `message_end` 处理完才开始工具预检"，而且监听器会被 await。所以工具其实还没开始执行，理由不成立。可以换成"可以在监听器里决定 strip 或 abort" | S-01 Q4、Q8 | 改正理由；strip 的方案可以保留 |
| S-2 | 建议 | §11、§4.2 规则 3 | 转义 `<system_event` 和 `<run_context` 时没说大小写、空白、全角（`＜`）、零宽字符怎么处理；LLM 自己输出的 `<system_event` 也没处理（下一次运行时它会以 assistant 身份出现） | §11 原文 | 先 NFKC，再去掉零宽字符，然后用大小写不敏感的正则 `<\s*/?\s*(system_event\|run_context)`；assistant 文本落库前也做同样的转义 |
| S-3 | 建议（疑问） | §3.7、§5.1 | 假设 toolCallId 在整个会话里唯一，S-01 没有验证 | S-01 Q2 的 id 形如 `call_00_…` | 拿 T09 的黄金日志统计一下；hands 的幂等键可以考虑改成 `(sessionId, runId, toolCallId)` |
| S-4 | 建议 | §3.6 INTERRUPTED 模板 | 措辞（"call the tool again"）和 S-01 Q4 测过的模板（"Ask the user before retrying"）不一样，"会先问用户"这个观察不能直接沿用 | S-01 Q4 | 列进评测，或者沿用测过的措辞 |
| S-5 | 建议 | §9.2 | 原文"'上海'、'shanghai'、'Shanghai' 永远是同一个值"：其实"上海"会被拒绝（返回 INVALID_INPUT），并不会存成同一个值 | §7.5 自己的规则 | 改正表述 |
| S-6 | 建议 | §7.1 第 4–5 步 | 模糊匹配的 score 怎么算没定义，所以"分数 ≥ 0.9 → exact"没法实现（影响 T03） | 原文 | 给出公式，比如前缀 0.95、包含 0.9、编辑距离 `1 - d/len` |
| S-7 | 建议 | §6.3a | 原文"不会影响前缀缓存"说过头了：每开一次新运行，上一次运行从第一个 thinking 块开始的缓存都会失效 | §6.3a 原文；§4.4 | 改成"只影响最近一次运行的那一段"；接受这一点就行 |
| S-8 | 建议 | §3.4 上限、§12 | 轮次、工具次数、连续失败次数的计数器在内存里，崩溃后归零 | 原文 | 从日志里推导，或者写明"按 attempt 计" |
| S-9 | 建议 | §7.5 | `preferred_language` 的 value schema 是 `string 1..80`，靠 hands 再检查枚举 | 原文 | 改用按 key 区分的 union schema，直接写成枚举 |
| S-10 | 建议 | §6.2 Node | S-01 是在 Node 22.23.5 上测的，D-21 定的是 Node 24 | S-01 头部；D-21 | T09 开工时在 Node 24 上把 S-01 的脚本重跑一遍 |
| S-11 | 建议 | §2.2；A-01 §7 | harness 直接 publish 临时事件，没有 fence，旧 worker 还能推 delta 或 reset | A-01 §7 | 临时事件带上 fence，gateway 扇出时丢掉 fence 过期的 |
| S-12 | 建议 | §6.2 遥测 | span 划分只有一行（验收标准 1 偏弱） | — | 补充 span 属性：runId、attempt、toolCallId、cacheRead 等 |
| S-13 | 建议 | §8.4、§4.2 规则 4 | `ticketNo` 在 booking.confirmed 的 payload 里，不在 summary 里，但允许集合只取 summary | A-01 §6.3 | 把允许集合改成"整个 payload" |

### 4.1 数字守卫（numberGuard）算法评估

**漏报（该拦没拦）**
1. **攻击者可以控制允许集合**：用户消息里的数字都在 A 里。红队用例"应该是 $1"可以通过（I-8）。
2. **中文数字**：比如"两千三百四十美元""一万八千公里"，§13.3 已经承认。
3. **全角数字**：比如"２３４０"。JS 正则里的 `\d` 只匹配 ASCII。应该先做 NFKC。
4. **数字用错了地方**：允许集合里的数字被放到错误的语义位置，比如把总距离 `18000.00` 说成价格"USD 18000.00"，或者把 A 报价的价格说成 B 报价的。守卫只检查集合，不检查绑定关系。
5. **用"万"或"k"做量级**："1.8万公里"会因为带小数被抓到；但"18k km"里的 18 小于 100，而且没有小数点，只有在上下文里出现 `km` 时才会被判为敏感。12 字符的窗口有时会漏掉单位。
6. **用空格分隔千位**："2 340"会被拆成"2"和"340"。340 会被抓到，但这样是靠运气。
7. **"已出票"声明**：正则只覆盖几种说法，像"all set""搞定了""座位已经给您留好"这类说法都识别不了。

**误报（不该拦却拦了）**
1. **日期和年份**：比如"2026年11月18日"。2026 ≥ 100，会被判为敏感；`today` 不在允许集合里（集合只取了"run_context 里的画像"）。
2. **上一次运行的数字**：允许集合只取"本次运行"的工具结果。用户在下一次运行里问"刚才那条路线多远"，LLM 引用上一次运行 `list_my_tickets` 或 `resolve_city` 里的距离，就会被拦。
3. **ID 里的数字**：比如 quoteId、ticketNo 里出现 `399` 这样的片段（ULID 里是常见的），如果 ID 来自上一次运行，就会被拦。
4. **用户自己说的大数字**：比如"我 300 号到"。这个在允许集合里，所以不会误报，但这正好就是漏报第 1 条。

**建议的算法调整**（不违反 D-36）
- 先做 NFKC，再去掉零宽字符，然后抽取数字；
- 分两层允许集合："带单位或货币的敏感数字"只能来自本会话所有工具结果的 `data.display`、booking payload 和画像；"不敏感的数字"可以来自任何地方，包括用户消息；
- 把 run_context 里的 `today` 和日期模式（`\d{4}-\d{2}-\d{2}`、`\d{4}年`）排除掉；抽取之前先把 ID 模式（`[qt]_[0-9A-Z]{26}`、`OA-[0-9A-Z]{8}`）去掉；
- 中文数字可以先做一个小的解析器（零到万，几十行代码），或者至少在旁边是货币或距离词时，把汉字数字也判为敏感，直接触发重新生成。

---

## 5. 和 S-01 不一致、或者在 S-01 里找不到依据的清单

| # | A-02 的位置 | A-02 的假设 | S-01 的情况 | 结论 |
|---|---|---|---|---|
| 1 | §0 总览图 | "pi Agent（prepareRequest 重建）" | Q3/Q8：主路径用 `initialState.messages`，不用 prepareRequest | **不一致**（正文 §3.4 是对的，总览图过时） |
| 2 | §6.1 `AgentRuntime` | `runContext` 每次请求时注入；`input: "prompt"\|"continue"` | Q3 和 D-49 都不支持请求时注入；§3.4 自己规定只用 continue | **不一致**（I-13） |
| 3 | §8.4 | "这时 pi 已经开始执行工具" | Q4："Agent 类会等 message_end 处理完才开始工具预检" | **不一致**（S-1） |
| 4 | §3.4、§6.1、§12 | `finishTurn` 返回 `{action:"end"}`；`agent.abort()`；`message_update` 事件；`afterToolCall` 可以用；请求超时和 pi 内部的重试；429 的 retry-after | S-01 没有测试过（Q5 只观察到 afterToolCall 没被调用） | **没有依据**，要补进 §6.5 |
| 5 | §6.1 | `execute` 抛错会被转成 `isError` 的结果；`details` 不会发给 LLM | 只有 R-01 的文档描述，S-01 没有实测 | **没有依据**（S-01 是唯一可靠来源） |
| 6 | §6.2、§17.3、D-44 | `executionMode` 每个工具单独设；并行时 toolResult 保持源顺序；批里有 sequential 就整批串行 | 只有 R-01，S-01 没有测并行 | **没有依据**（B5） |
| 7 | §6.3 最后一行 | "流式错误不会被抛出，而是作为 error 事件发出" | S-01 里没有这个结论 | **没有依据** |
| 8 | §3.4 第 3 步 | `initialState` 里同时传 `systemPrompt` 和含 system 消息的 messages | Q3 只说 `messages[0]` 是 system 加 toolsAdded；没测两者同时存在时怎么处理，也没测 prompt 变化后会怎样 | **没有依据**（§6.5 第 3 条只覆盖了一部分） |
| 9 | §3.6 INTERRUPTED 模板 | 引用 Q4 的观察："模型会先问用户，不会自己重试" | Q4 测的模板是"Ask the user before retrying"，A-02 的模板是"call the tool again" | **措辞不同，结论不能直接沿用**（S-4） |
| 10 | §6.3 第 4 行 | "参数校验失败的调用不会进 beforeToolCall（S-01 Q6）" | 结论在 Q5 里，不在 Q6 | 引用位置写错了，结论一致 |
| 11 | §6.3a | 已结束的运行去掉 thinking，当前运行保留，DeepSeek 接受这种混合历史 | Q3 只验证了"原样全部重放" | 已经列在 §6.5 第 6 条 ✓ |
| 12 | §6.2 | 在 model 对象上设 `maxTokens` 会生效 | Q8 只观察到默认值是 384000 | 已经列在 §6.5 第 4 条 ✓ |
| 13 | §6.3c | `Value.Check(schema, toolCall.arguments)` 放在 beforeToolCall 的第一步 | Q9.1 已经验证（`rawStrictCheck`），pi 会先做转换校验再进钩子 | **一致** ✓ |
| 14 | §6.3b | 默认端点不用 strict；/beta 不能有 optional 字段和 Never | Q6、Q9.4 | **一致** ✓ |
| 15 | §3.6 | harness 自己补齐；禁止依赖 "No result provided" | Q4 | **一致** ✓ |
| 16 | §3.4、§4.2 规则 5 | system 消息和 toolsAdded 要落库、要重放 | Q3 第 1 条、Q8 第 6 条 | **一致** ✓（但第一次运行时 system 消息放在哪里，要等 §6.5 验证） |
| 17 | §3.4 第 5 步 | `tool_execution_start` 早于 beforeToolCall | Q5 | **一致** ✓ |
| 18 | §6.2 | 不能用 `minimal`/`medium`；low 对应 `reasoning_effort:"low"` | Q3、Q8 第 9 条 | **一致** ✓ |

---

## 6. 和 A-01 的接缝矛盾

| # | A-01 的位置 | A-02 的位置 | 矛盾 | 建议以哪边为准 |
|---|---|---|---|---|
| X-a | §5.2 L609："A-02 §3.3 会把这个 booking.confirmed 当成待处理输入，和新的 user.message 一起放进 inputSeqs"；§16.2 X-14"后者保留" | §3.3"booking.* 不再算输入，只是上下文事件"；§4.2 规则 1 | 一边算输入，一边不算。引用的规则编号（A-02 §4.2 规则 2）也不对 | 以 A-02 为准（更简单，和 D-39 一致），但投影位置要按 B2 的修法来；A-01 删掉 L609 那句 |
| X-b | §5.2 失败表 L619"本文暂时按'按门铃'写"；§6.3 状态表 L703"写入 user.message 或 booking.failed，并且按了门铃 → queued" | §3.1、§16.3 C-2/C-3 | D-51 ✅ 已定为不唤醒，A-01 还没改 | 以 D-51 为准，A-01 要改 |
| X-c | §7 L738：恢复扫描每 60s，阈值 90s | §16.2 X-11：queued 10s、running 45s、每 15s 扫一次 | 数值不一致 | 父会话合并契约时统一，建议用 A-02 的值 |
| X-d | §6.3"`agent.run_completed` → idle" | §3.5 释放后再检查 | 运行期间到达的消息被 idle 覆盖，恢复扫描看不到它（B3 的另一半） | A-01 的状态推导要考虑未消费的输入 |
| X-e | §5.1 第 1 步的说明："下一次运行的 projector 会按 runId 和 attempt 处理（A-02 §3.6、§4.2）" | A-02 没有这条规则 | A-01 依赖了一条不存在的规则 | A-02 补上（I-10） |
| X-f | §6.3、§16.1 R-10：`meta.template` 是 payload 字段；§5.1 第 4 步按 schema 严格校验 | §2.1 的 `agent.message` payload 里没有 `meta` | 模板消息会被 400 拒绝 | A-02 的 §2.1 加上 `meta`（I-4） |
| X-g | §7：harness 直接 publish `{kind:'eph'}` 到 `sse:session:{sid}` | §2.2 没写发送路径 | A-02 读者不知道临时事件怎么发；这条路径也没有 fence | A-02 §2.2 引用 A-01 §7，并加 fence（S-11） |
| X-h | §5.1：emit 支持 1..20 条批量、原子写入 | §3.4 一次只写一条 | 不算矛盾，但 A-02 没有用上这个能力来修 I-5 | A-02 用批量写入 |
| X-i | §6.3 booking.confirmed 的 payload：`{quoteId, ticketId, ticketNo, summary}` | §8.4 允许集合只取 summary | ticketNo 被漏掉 | A-02 改成取整个 payload（S-13） |

A-01 和 A-02 都已经正确同步的：jobId `wake-`、traceparent（X-5、X-9）、Ed25519 hands token（X-1）、记忆只插入（X-3）、messageKey（X-4）、`quote.offered` 的严格校验、tool_calls 放在 Postgres 里做幂等。

---

## 7. 安全论证复核

### 7.1 "agent 没有任何下单途径"
§13.1 的六条途径（下单工具、hands 写 tickets、harness 直连 booking、伪造事件、注入让 LLM"点击"、文字确认）都成立。用 A-01 的授权核对过：hands 对 tickets 只有 SELECT；booking 只接入 `bk`/`db_booking` 网络；gateway 的事件类型白名单禁止 harness 写 `booking.*`；只有浏览器带 CSRF 的点击才会触发出票。**没有发现能出票的漏洞。**
剩下的是"误导"类风险，都不能直接出票，最终仍然要用户点按钮，而卡片上显示的是数据库里的真实数据：
- LLM 可以对任何**已经存在**的本会话报价调用 offer_booking，然后在文字里劝用户点击。
- 旧 worker 可以推送临时 delta（S-11）。
- LLM 可以在自己的回复里输出 `<system_event …>`，下一次运行时它以 assistant 身份出现，可能让模型以为已经出票（S-2）。

### 7.2 提示注入
| 入口 | 能不能突破规则 | 说明 |
|---|---|---|
| 用户消息 | 不能出票；**能**让违规数字通过守卫（I-8） | 允许集合包含用户输入 |
| 伪造 `<system_event>` | 基本能挡住，但转义规则没定死（S-2） | 要处理大小写、全角、零宽字符 |
| 工具结果 | 风险低 | 只有 resolve_city 会回显 original（最多 80 字符）；其他工具的文本都来自库里的规范值 |
| 记忆 | 风险低 | 只存枚举值和规范城市名；但 San Jose 碰撞会存错（I-9） |
| run_context | 风险低 | 值全部由代码渲染，来源是枚举和规范名 |
| 伪造 booking.confirmed 让 agent 说"已出票" | 用户写的会被转义；agent 自己写的没有处理（S-2） | — |

---

## 8. 正确性复核小结（租约、门铃、恢复、投影、裁剪）

- **租约和 fence**：B1（INCR 的顺序）。续租和释放的 Lua 没有问题；不存在死锁（锁有 TTL）；但 B1 会造成"活锁式"的反复误杀。
- **门铃**：B3（自己按门铃被去重吞掉，再加上状态被 idle 覆盖）。
- **释放后再检查**：思路对，但它依赖的"自己按门铃"在 BullMQ 的语义下不成立。
- **崩溃恢复**：分情况的表和补齐规则都好；缺了 I-5（quote.offered）、I-6（异常结束时没补齐）、I-10（旧 attempt 的残留消息）。
- **投影的确定性**：B2（输入的位置）是根本问题；system 消息的位置要等 §6.5 验证；run_context 的"提前"放置要随 B2 一起改写。
- **上下文裁剪**：§4.3 的逐条替换成占位符，每跨过一次阈值，前缀就变一次。§17.3 自己也承认这一点，交给 D-46/R-02。会丢信息的部分：resolve_city 的 nearestServed 和候选列表被换成占位符之后，没有工具可以取回（§17.3 只提到报价和机票能取回）。"保留最近 N 次运行，其余合并成摘要"的 N 没有定义。考虑到上下文窗口有 1M，而 D-40 的预算是 40k，v1 正常会话碰不到上限，这部分可以暂缓（见 §9）。

---

## 9. 过度设计和简化建议（都不违反已确认的决策）

1. **§4.3 的两级裁剪和 §17.3 的检查点**：v1 可以只实现"超预算就写 run_failed（CONTEXT_TOO_LARGE），提示用户新开一个对话"，再加一个指标。等 R-02 有结论再做压缩。上下文窗口 1M，订票会话很短。
2. **自定义 `LlmMessage`、`piExtra` 和双向无损映射**：面试项目可以直接存 pi 的 `AgentMessage` JSON（S-01 Q3 证明可以无损往返），另外加一个 `piVersion` 字段。适配层只在 import 边界做隔离，省掉往返测试和字段映射。这和 D-02 不冲突。
3. **守卫的 `stripped` 分支**：带工具调用的消息里的文字，可以直接整段丢掉，不落库，也不发 guard_violation。只保留 regenerate 和 replaced 两条路径（D-36 要求的就是这两条）。
4. **"同一个工具连续失败 3 次就 block"**（§12）：已经有 12 次工具调用和 8 轮的上限兜底，这条可以删掉。
5. **成本单价表的版本和生效日期**（§6.4）：一个常量就够了。
6. **评测里的 thinking 开和关的延迟对比、matchedBy 统计、缓存命中率**：保留指标的输出，但不作为通过标准，也不用做专门的对比实验。
7. **`agent.status`**：和 `agent.tool_status`、`agent.delta` 有重叠，前端可以从 delta 推断"正在输入"。
8. **save_preference 的"本次运行必须有 user.message"检查**：D-39 之后这条恒为真，§7.5 自己也这么说，可以删掉，或者只写成断言。
9. **自己按门铃**：按 B3 的修法改成在同一个任务里循环，反而更简单，还少一次队列往返。

---

## 10. 最关键的 5 个问题

1. **B1** §3.2 先 INCR fence 再 SET NX：每个多余门铃都会让正在运行的持有者收到 FENCE_STALE，被误杀。
2. **B2** §4.2 输入事件留在自己的 seq 位置：运行中途到达的消息会让下一次运行的末尾变成 assistant，`continue()` 抛错，或者拆开 toolCall/toolResult 导致 DeepSeek 400。
3. **B3** §3.5 自己按门铃会被 BullMQ 的 jobId 去重吞掉，加上 run_completed 把状态改成 idle，运行期间到达的消息会永久丢失。
4. **B4** §3.7 messageKey 的序号 n 没有定义，守卫重新生成时会撞键，导致回复或守卫事件被静默去重。
5. **B5 和 I-1** D-44（并行加按原始顺序落库）、D-45（`key: value` 行）已经确认，正文还是旧方案；同时数字守卫把用户消息里的数字放进允许集合，红队用例"$1"能通过（I-8）。
