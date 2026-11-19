# R-02 上下文工程调研：prompt cache、卸载与组装（供修订 A-02 §4）

- 日期：2026-11-18
- 范围：只调研、只给建议。A-02 及其他已有文件**没有修改**；本报告不调用 DeepSeek API。
- 输入：`docs/design/A-02-agent.md` v0.3（§4、§6.3a、§2.1、§14.3）、`spikes/S-01/REPORT.md`（Q3、Q7、Q9）、`docs/design/A-01-frontend-backend.md`（events 表结构）。
- 引用约定：原文引用每处不超过 15 个词，其余为转述。"已核实"指在一手文档里读到；"未核实"指推断或文档没写。

---

## 1. 结论摘要

1. DeepSeek 缓存是**自动生效的前缀缓存**：只有从开头起逐块完全一致的部分才算命中，命中单价是未命中的 1/50。所以"前缀稳定"直接决定成本，也影响延迟。
2. 父会话的疑点成立：§4.3 的"逐步替换 toolResult"和"保留最近 N 次运行"都是滑动的规则，越过阈值以后**每次运行都会改写前缀**，缓存会反复失效。此外还有 3 个更隐蔽的破坏点：已结束运行的 thinking 被去掉（按官方文档还会直接返回 400）、jsonb 会重排键的顺序、运行期间到达的 `booking.*` 被插回历史中间。
3. 推荐把裁剪改成**检查点式的一次性压缩**：触发后写一条 `agent.context_compacted` 事件，带高低水位线（滞回），并且只在运行开始前做。这样前缀只在压缩点变一次，上下文有上界，被卸载的内容都还在日志里，可以按 ID 找回。
4. 订票会话很短，40k 的预算基本碰不到，压缩机制**先定规则、写最小实现**就够了。真正要先修的是上面 3 个破坏点，而且修起来几乎没有成本。
5. 用一个确定性测试保证前缀稳定，作为 CI 的硬门槛：对同一份日志，在越来越晚的截断点上分别投影，前一次的结果必须是后一次的前缀。缓存命中率只在评测里报告。需要人拍板的有 7 项（R2-1 到 R2-7）。

---

## 2. DeepSeek 缓存的事实

| # | 事实 | 状态 | 来源 |
|---|---|---|---|
| F1 | **默认对所有用户开启**，不需要改代码。原文是 "enabled by default for all users" | 已核实 | [KV Cache 指南][ds-kv] |
| F2 | **前缀匹配**：后一个请求和之前请求重叠的**前缀**才能命中，而且必须完整匹配一个"缓存前缀单元"，部分重叠不算 | 已核实 | [ds-kv] |
| F3 | 前缀单元在什么时候落盘：(1) 每个请求的用户输入末尾和模型输出末尾；(2) 发现多个请求有公共前缀时；(3) 输入或输出很长时，每隔固定的 token 数 | 已核实 | [ds-kv] |
| F4 | **粒度**：现行指南只说"固定 token 间隔"，没有给出数字。2024-08 的发布公告说以 64 token 为一个存储单元，不足 64 token 不缓存。S-01 Q7 测到的 `cacheRead = 128`（共 256）是 64 的倍数，和这个说法吻合 | 现行文档**未核实**；64 来自旧公告，S-01 的数据可以佐证 | [ds-kv]、[发布公告][ds-news]、S-01 Q7 |
| F5 | **TTL**：没有固定 TTL。不再使用的缓存通常在"几小时到几天"内清除。缓存要几秒钟才能建好 | 已核实 | [ds-kv] |
| F6 | **best-effort**：官方明确说命中率不保证 100% | 已核实 | [ds-kv] |
| F7 | usage 字段是 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。pi 把它们映射成 `cacheRead` 和 `input`（`input` 不含命中部分，S-01 Q7） | 已核实（文档加 S-01 实测） | [ds-kv]、S-01 Q7 |
| F8 | **计费**（每 1M token，peak / off-peak）：`deepseek-flash` 命中 $0.006 / $0.003，未命中 $0.30 / $0.15，输出 $1.20 / $0.60。**命中价是未命中价的 1/50**。缓存存储不另收费（旧公告）。pi 目录里的单价（S-01 Q7：$0.3 / $1.2 / $0.006）和 **peak** 价一致，off-peak 是它的一半；off-peak 时段的定义见价格页 | 已核实 | [价格页][ds-price]、[ds-news] |
| F9 | **型号**：价格页明确列出了 `deepseek-flash`（当前版本是 DeepSeek-V4.1-Flash-1017），旧名 `deepseek-v4-flash` 仍然可以用。**KV Cache 指南没有说缓存适用于哪些型号**，只说对所有用户默认开启；S-01 Q7 在 `deepseek-flash` 上实测到了命中 | 型号存在：已核实；缓存是否适用于 flash：文档没写，**有实测佐证** | [ds-price]、[ds-kv]、S-01 Q7 |
| F10 | **thinking 和工具同时使用时**：只要请求里带了 `tools`，之前所有轮次的 `reasoning_content` 都必须完整回传，没有调用工具的轮次也一样。不回传会返回 400，原文是 "the API will return a 400 error"。不带 `tools` 时，之前的 reasoning 会被忽略 | 已核实（文档），**未实测** | [Thinking Mode 指南][ds-think] |
| F11 | 什么会导致不命中：文档只写了"前缀不同就不命中"。**没有说明** system 和 `tools` 在内部怎么序列化，也没有说明 `tools`、`thinking`、`reasoning_effort` 这些参数是否参与缓存键 | 未核实（文档没写） | [ds-kv] |
| F12 | 推论（由 F2 得出，没有实测）：`tools` 在模型内部很可能渲染在 prompt 的最前面，所以任何工具声明的改动（顺序、字段、描述）都可能让**所有会话**从头开始不命中；消息里的 id、时间戳、JSON 键的顺序、Unicode 转义的写法，只要有一个字节不同，从那一处开始往后都不命中 | 未核实（推断） | [ds-kv]、[Manus][manus] |
| F13 | Postgres 的 `jsonb` 不保留空白，**也不保留对象键的顺序**（文档原文："does not preserve the order of object keys"）。A-01 的 `events.payload` 用的就是 jsonb | 已核实 | [PG JSON 类型][pg-json]、A-01 §events 表 |

---

## 3. 业界实践要点（只挑和本项目相关的）

**Anthropic：Scaling Managed Agents**（[链接][anthropic-ma]）
- session 是放在上下文窗口之外的持久事件日志，`getEvents` 可以按位置取切片，比如从上次读到的地方继续，或者往回倒几条。
- 在送进模型之前，由 harness 对事件做变换（组织上下文、压缩、裁剪旧的工具结果和 thinking），目标之一是提高 prompt cache 命中率。
- 选择性地保留或丢弃上下文，这类决定一旦不可逆就容易出错（原文："irreversible decisions to selectively retain or discard context can lead to failures"）。因为完整历史一直留在 session 里，丢弃的东西可以找回。**对本项目的含义**：裁剪只发生在投影里，日志永远完整，这一点 A-02 已经做到了；但"能找回"还要求模型有找回的**途径**（ID 加工具）。

**Anthropic：Effective context engineering for AI agents**（[链接][anthropic-ce]）
- 上下文越长，模型的召回能力越差。上下文是边际收益递减的有限资源，应该只保留高信号的最小集合。
- **清除工具结果**是最轻、最安全的压缩方式。压缩过头会丢掉以后才发现很关键的细节，所以压缩规则要先保证召回，再追求精简。
- 即时检索：上下文里只放轻量的标识符（路径、ID），需要时再取。这对应 `quoteId` / `ticketId` 加上取回工具的做法。

**Anthropic：Context editing 文档**（[链接][anthropic-edit]）。这是"按阈值清除工具结果"的一个现成参照：
- `clear_tool_uses` 有几个参数：`trigger`（阈值）、`keep`（保留最近几次工具调用）、`clear_at_least`（每次至少清掉多少）、`exclude_tools`（哪些工具不清）。
- 文档明确说，清除会让缓存前缀失效，每次清除都要付一次写缓存的成本。`clear_at_least` 就是用来保证每次清得足够多，**这次失效才划算**；达不到就不清，缓存也不受影响。这和本报告推荐的"高低水位线 + 一次性压缩"是同一个思路。
- 清除 thinking 时，缓存会从被清除的位置开始失效。是保留 thinking 换取命中，还是清掉 thinking 节省空间，需要自己取舍。

**Manus：Context Engineering for AI Agents**（[链接][manus]）
- 把 KV cache 命中率当作最重要的生产指标。agent 的输入远多于输出，缓存价格差 10 倍。DeepSeek 的价格差是 50 倍，缓存更重要。
- 前缀要稳定：系统提示词开头不要放精确到秒的时间戳。原文："Even a single-token difference can invalidate the cache from that token onward"。
- **上下文只追加**，不要回头改写之前的动作和观察结果。
- **序列化要确定**：很多语言和库不保证 JSON 键的顺序，会悄悄破坏缓存。对应本项目的 F13。
- **用 mask 代替删除工具**：会话中途增删工具会让缓存失效，也会让模型困惑。Manus 的做法是在解码时屏蔽不允许的动作，并且给工具名加统一的前缀。本项目在 `beforeToolCall` 里 block 而不是移除工具，思路相同。
- **压缩必须可以恢复**：网页内容可以丢，但 URL 要留下；文档内容可以丢，但路径要留下。对应本项目的"丢掉报价的正文，留下 quoteId"。
- 错误信息要留在上下文里，帮助模型修正自己的判断。§5.1 的 `ERROR` / `BLOCKED` 前缀符合这一点，裁剪时也不应该优先删掉它们。

**OpenAI：Compaction**（[链接][openai-compact]）
- 两种用法：一是在请求里设 `context_management.compact_threshold`，超过阈值时由服务端自动压缩，产出一个加密、不透明的 compaction item；二是调用无状态的 `/responses/compact` 端点，主动压缩并返回一个新的上下文窗口。
- 在无状态链式调用里，最近一个 compaction item **之前**的条目都可以丢掉。也就是说，压缩是一个**检查点**，压缩之后照常只追加。文档还要求不要再手工修剪压缩的输出。
- 这对本项目的启示是做法，不是直接用：DeepSeek 没有这样的端点；而且 LLM 生成的摘要不确定，还可能带进错误的数字，A-02 §4.3 不用 LLM 做摘要的理由仍然成立。我们借用的是"检查点 + 之后只追加"这个结构。

---

## 4. 对当前 A-02 §4 的问题诊断

下文"前缀断点"指相邻两次请求中，第一个不同的字节所在的位置。断点之后的内容全部不命中。

| # | 位置 | 问题 | 后果 | 严重度 |
|---|---|---|---|---|
| P1 | §4.3 第 2 条（逐步替换 toolResult） | 替换从**最早的运行**开始，并且是"超出多少就替换多少"。会话一旦越过阈值，以后每次运行几乎都会再多替换一条，每次都在历史的**最前面**产生断点 | 越过阈值之后，几乎每次运行都要从 system 之后整段重算，命中率掉到只剩 system 前缀。父会话的判断成立 | 高（但触发概率低，见 §5.4） |
| P2 | §4.3 第 3 条（保留最近 N 次运行，更早的合并成摘要） | 这是一个滑动窗口：每多一次运行，最早的一次就被并进摘要，摘要的内容也跟着变 | 和 P1 一样，每次运行都会在前面产生断点 | 高（触发概率低） |
| P3 | §4.1 `project(events, budget)` | 投影结果依赖预算和 token 估算器。改了这两项配置或估算方法，**所有正在进行的会话**的历史都会被改写，而且不一定会去改 `projectorVersion` | 一次配置变更就让全部会话的缓存失效；"给定同样的日志得到同样的请求"这个重放一致性也会被破坏 | 中 |
| P4 | §6.3a（已结束运行的 thinking 被去掉） | (a) 第 k 次运行时，它自己的 thinking 在请求里；到第 k+1 次运行，这些 thinking 被去掉，断点落在第 k 次运行的第一条 assistant 消息上。所以"不影响前缀缓存"这个说法**只对第 k 次以前的历史成立**，第 k 次运行里的工具往返每次都要重算。(b) 更严重的是，按 F10，带 `tools` 的请求如果少了之前的 `reasoning_content`，**会返回 400**。§6.3a 已经预留了"退回全部保留"，官方文档说明这个退路是必然要走的 | 正确性问题（400），外加每次运行都有一个断点 | **高** |
| P5 | §2.1 / A-01 events 表（`payload jsonb`） | 第 k 次运行里，pi 发出去的 assistant `tool_calls.arguments` 是模型原样输出的键顺序，比如 `{"from":…,"to":…}`。第 k+1 次运行从 jsonb 读回来，键的顺序变了（jsonb 按键的长度排序，会变成 `{"to":…,"from":…}`）。`run_context` 里的 `profile` 和 `<system_event>` 的 JSON 也有同样的问题。另外 jsonb 会把 `ã` 这样的转义统一成字符本身 | **每次新运行**，断点都会落在上一次运行的第一个 toolCall 上；§4.1 要求的重放一致性黄金测试也会失败 | **高**（推断，F13 加上 pi 用 `JSON.stringify` 序列化参数；T09 的黄金测试能复现） |
| P6 | §4.2 规则 1 和规则 4（`booking.*` 投影在自己的 seq 位置） | 第 k 次运行期间到达的 `booking.confirmed`，在第 k 次运行里被排除；到第 k+1 次运行，它被**插回第 k 次运行的中间**。如果插入的位置正好在某个 assistant(tool_calls) 和对应的 tool 消息之间，还会把工具调用和结果拆开。用户在模型还在说话或者还在调工具时点了按钮，就会出现这种情况 | 在历史中间产生断点；最坏的情况下请求格式不合法（user 消息夹在 tool_calls 和 tool 之间） | 高（正确性加缓存） |
| P7 | §4.3（可找回性） | 占位符只留了 `{name} {简短摘要}`。日志里内容都还在，但模型**没有工具**去取回某个旧报价的路线 | 用户说"刚才那张经停哪里"时，模型只能重新报价或者瞎猜 | 低（`quote_route` 的 llmText 本来就短，也不带数字，见 §5.1） |
| P8 | §4.4（工具集和提示词） | 文档已经写明修改提示词或工具集会让缓存失效。还要补一条：工具集必须对所有会话、所有运行都完全一致，包括顺序和描述。按 F12，`tools` 很可能在最前面 | 一旦按会话裁剪工具，所有会话都不能共享 system 前缀 | 低（现在的设计已经满足，写成规则就行） |

不需要改的地方：
- 旧的 run_context 留在历史里（§4.4），这样只追加，是对的。
- 当前运行永远不裁剪，是对的。
- 不用 LLM 做摘要，是对的。
- `today` 只精确到日期，并且放在 run_context 里，不放在 system 里，是对的。
- system 前缀里没有动态内容，所有会话可以共享，是对的。

---

## 5. 推荐方案

### 5.1 先修 3 个破坏点（几乎没有成本，不管做不做压缩都要修）

1. **thinking 全部保留（修 P4）**：只要请求带 `tools`，就不再去掉已结束运行的 thinking，在 §6.3a 里直接走"退回全部保留"的分支，thinking 也计入 §4.3 的预算。T09 仍然要用一次真实请求确认会不会 400（§6.5），但设计按文档定下来，不再把"去掉 thinking"当默认。
   - 代价：上下文增长得更快。低档推理每条 assistant 消息大约多几十到几百个 token。
   - 另一种选择：如果以后要压缩 thinking，只能通过 §5.2 的检查点，把旧的运行**整体**折叠成摘要，这样旧的 assistant 消息整条消失。整条消失以后是否还会 400，需要在 T09 实测。
2. **pi 消息按原样字节存储（修 P5）**：`agent.message.payload` 里增加 `messageJson: string`，内容是 `JSON.stringify(piMessage)` 的原文。jsonb 里的字符串值会逐字节保留；projector 用 `JSON.parse` 还原，JS 会保持原来的键顺序。现有的结构化字段可以留着，供查询和审计用。
   - projector 自己拼出来的 JSON（`run_context` 和 `<system_event>`）一律用**规范序列化**：键按字典序排列，不加空白，不转义非 ASCII 字符，可以参考 RFC 8785 的思路。这样**第一次运行时用内存里的对象拼，和以后从 jsonb 读回来再拼，得到的字节完全一样**。
   - 代价：每条消息要多存一份字符串，大约是原来的两倍，在 64KB 的上限之内。另外 A-01 的事件 schema 要加这个字段。
3. **`booking.*` 改成挂在运行边界上（修 P6）**：`booking.*` 事件不再放在自己的 seq 位置。它属于"在它之后开始的第一次运行"，在那次运行的 run_context **之前**按 seq 顺序插入。没有后续运行时，就不投影。
   - 效果：投影结果只会在末尾追加，工具调用和结果永远不会被拆开；而且和 §4.2 规则 1 已有的"seq < S 才投影"语义一致，第一次运行和恢复时得到的结果相同。
   - 代价：projector 多一条规则，加一个单元测试（用例：在 tool_calls 和 toolResult 之间插入 booking 事件）。

### 5.2 裁剪和压缩：检查点式一次性压缩（取代 §4.3 的第 2、3 条）

**规则**（确定性，T09 要有单元测试）：
- **只在运行开始前判断**：在 emit `run_started` 之前，harness 用 projector 估算"如果现在开这次运行，上下文有多大"。如果超过**高水位 H**（默认 40k，沿用 D-40），就先 emit 一条 `agent.context_compacted`，再 emit `run_started`。运行中间**永远不压缩**，所以同一次运行里的工具往返，前缀始终稳定。
- **一次性压到低水位 L**（默认 16k）：从最新的运行往前数，保留尽可能多的完整运行，使它们的总大小不超过 L，**至少保留 1 次**；更早的所有运行折叠成一条摘要。
- **事件写什么**：`{ compactionId, boundarySeq, summaryText, summaryVersion, estBefore, estAfter }`。`summaryText` 由代码生成并**原样落库**，以后 projector 直接用这段文字，不重新计算。这样以后修改摘要的代码，也不会改写历史会话的前缀，修好了 P3。
- **投影**：`[system] [最近一条 compacted 的 summaryText，作为 user 角色的 <system_event type="context_compacted">] [boundarySeq 之后的事件按原规则投影]`。projector 本身**不再依赖预算参数**，签名回到 `project(events)`。预算只在 harness 决定"要不要写压缩事件"时使用。
- **摘要的内容**（不带数字，按 seq 顺序）：
  - 每个报价一行，直接复用 `quote_route` 那条不带数字的 llmText，比如 `q_… Shanghai → Dubai → São Paulo (1 transfer at Dubai)`；
  - 每张票一行：`ticketId` 加路线；
  - 用户在这些运行里提到过的规范城市名；
  - 最后附一句说明："更早的细节已经卸载；票据用 list_my_tickets 查，报价以 quoteId 为准"。
  - 报价最多保留最近 K = 20 条，**保证摘要本身也有上限**。
- **找回**：所有原始内容都还在日志里。模型能用的找回途径：
  - 票据：已有的 `list_my_tickets`；
  - 报价：`offer_booking(quoteId)` 只需要 quoteId，摘要里有；
  - 报价的细节：可以考虑加 `get_quote(quoteId)`（R2-5）。
- **上界**：压缩之后上下文 ≤ L + 摘要（最多 K 行，约 1k 以内）。之后只追加，直到再次超过 H。单次运行的大小已经被 8 轮 / 12 次工具调用的上限限制住了。所以上下文始终不超过 **H + 单次运行的最大增长**，有界。
- **缓存代价**：每次压缩会让这一次请求几乎全部不命中，按 peak 价、40k token 算约 $0.012。之后在 L 和 H 之间的所有运行都只追加、可以命中。两次压缩之间至少隔着 H − L ≈ 24k token 的增长，相当于 Anthropic 的 `clear_at_least` 起的作用，不会出现 P1、P2 那样每次运行都失效的情况。
- **放弃"占位符逐条替换 toolResult"这一层**：本项目的工具结果本来就短（`quote_route` 和 `resolve_city` 的 llmText 只有一行，§7.1、§7.2），逐条替换省不了多少 token，却每次都会在中间产生断点。真正占空间的是 thinking 和多次运行累积下来的对话，整段折叠更划算。

各种做法的代价对比：

| 做法 | 有界 | 前缀稳定 | 可找回 | 实现代价 |
|---|---|---|---|---|
| 现在的 §4.3（逐步替换 + 滑动的 N） | 是 | **否**（越过阈值后每次运行都失效） | 部分（日志里有，但模型没有途径取回） | 中 |
| **检查点 + 水位线（推荐）** | 是 | 是（只在压缩点失效一次） | 是（ID + 已有工具，可选加 `get_quote`） | 中（多一种事件类型和一条投影规则） |
| 不压缩，到了硬上限就报错或开新会话 | 是 | 是 | 新会话里看不到旧会话 | 最低（但用户体验突兀） |
| LLM 摘要（像 OpenAI 那样） | 是 | 是 | 差（不确定，可能带进错误的数字） | 高，并且违反 H-01 |

### 5.3 组装顺序（§4.4）

保持现在的四段结构，再补几条规则：

```
[system]    静态提示词 + 工具声明：所有会话完全一致（工具的集合、顺序、描述都固定；改了就升级 promptVersion）
[summary]   最近一条 context_compacted 的 summaryText（如果有）            ← 新增，只在压缩点变化
[history]   boundarySeq 之后的历史：每次运行 = [挂在这次运行前的 booking.*] [run_context] [user 输入] [assistant/toolResult……]
            旧的 run_context 全部保留（保持只追加）；thinking 全部保留（§5.1-1）
[current]   本次运行：[booking.*] [run_context] [输入] ……
```

- **run_context（包括画像）**：继续放在每次运行的输入**之前**，并且每次运行一份，**不要**挪进 system。放进 system 的话，画像一变，所有前缀都会失效，也不能再跨会话共享 system。旧的 run_context 留着，每条大约 100 token，压缩时会和对应的运行一起被折叠掉，不需要单独处理。
- **不要**为了省 token 改成"只在画像变化时才发 run_context"。这样省得很少，却要增加一个需要跨运行比较的状态。
- 请求参数（`model`、`thinking`、`reasoning_effort`、`max_tokens`、`tools`）在一个会话里不变。`tools` 和 `thinking` 是否参与缓存键，DeepSeek 没有说明（F11），所以把它们当作参与。

### 5.4 订票场景下值不值得做

粗略估算：system 加工具声明大约 3k token；一次典型的运行有 2 到 4 次请求，增长 1k 到 2k token（含低档推理）；一个会话 3 到 8 次运行。所以大多数会话的上下文在 **5k 到 15k** 之间，**碰不到 40k**。一个会话大约 15 次请求、平均 6k token，按 peak 价：全部不命中约 $0.027，命中 90% 约 $0.003。每个会话能省下大约 2 分钱，6k token 的预填充也不慢。

所以判断如下：
- **§5.1 的三处修复必须做**。它们影响的是**每一个**多轮会话（P5、P6），其中两处还是正确性问题（P4 的 400、P6 的格式错误），而成本只是几条规则。
- **§5.2 的压缩机制**：把规则写进 A-02，并把事件类型列进契约。实现时只做"运行开始前判断，超过就折叠"这一条路径，用 CI 测试覆盖，**不做**逐条替换和动态调参。它的主要价值是保证上下文有界、不会出现缓存反复失效，而不是省钱。
- **不做**：`get_quote` 工具（先用摘要里的 quoteId 加路线兜底）；LLM 摘要；按会话裁剪工具集。

### 5.5 怎么测量

1. **缓存命中率**（评测时报告，不作为门槛，因为 F6 说了是 best-effort）：
   - 单次请求：`hit = cacheRead / (input + cacheRead)`，等价于 DeepSeek 原始字段的 `prompt_cache_hit_tokens / (hit + miss)`。
   - 会话级：`Σ cacheRead / Σ(input + cacheRead)`，按 token 加权。§14.3 已有这个公式，再补上"按 token 加权"和"去掉每个会话的第一次请求"两种口径。
   - 目标（建议，评测后再调）：会话里第 2 次及以后的请求，加权命中率 ≥ 80%；同一次运行里第 2 次及以后的模型轮次 ≥ 90%；新会话的第一次请求，命中部分应该接近 system 前缀的长度。
   - **理论上限**：`ceil_i = floor(LCP_i / 64) × 64`。LCP 用 token 数，可以用字符数按 §4.3 的方法估算，64 是 F4 的粒度。实际 `cacheRead_i / ceil_i` 衡量的是 DeepSeek 自己的 best-effort 程度，和我们的前缀稳不稳无关。分开统计，才能知道没命中到底是谁造成的。
2. **前缀稳定性**（确定性测试，**CI 硬门槛**，不调用 LLM）：
   - 性质测试：任取一份日志 E 和两个截断点 t1 < t2，并且两点之间没有 `context_compacted` 事件，要求 `project(E[..t1])` 是 `project(E[..t2])` 的**前缀**。比较方式是对每条消息的规范字节做逐条相等比较。
   - 用例要覆盖 P4、P5、P6：多次运行、thinking、运行中途到达 booking、恢复和补齐、guard regenerate。
   - 往返测试：投影 → `toPi` → 用 pi 的 openai-completions 序列化 → 字节结果，和第一次运行时 `onPayload` 抓到的请求比较，要求 `messages` 数组逐字节一致（§4.1 和 §6.5 的黄金测试，加上 jsonb 往返）。
3. **在线检查**（评测和线上都开）：对同一个 session 里相邻的两次请求 r_i 和 r_{i+1}，在 `onPayload` 里计算 `stable_i = LCP(r_i, r_{i+1}) / len(r_i)`（序列化后的 `messages` 加 `tools`）。
   - 期望 `stable_i = 1.0`，也就是上一次请求完整地是下一次请求的前缀。例外只有两种：刚写入 `context_compacted` 之后的那一次，和刚部署了新 promptVersion 之后的那一次。
   - 其他任何 < 1.0 的情况都记录成 `prefix_break{sessionId, offset, 前后各 64 个字符的片段}`，并作为评测指标"前缀断点数"，目标是 0。
   - 不需要落原始 payload，只要存 hash 和长度：在 harness 内存里保留上一次请求的序列化结果即可，因为同一次运行里的请求都在同一个进程里。跨运行的比较放在评测脚本里，用保存下来的 payload 做。

---

## 6. 待决策

| 编号 | 问题 | 选项（代价） | 推荐 |
|---|---|---|---|
| R2-1 | 超过预算时怎么裁剪 | A. **检查点式一次性压缩**：写 `agent.context_compacted` 事件，高水位 H、低水位 L，只在运行开始前做，摘要文字由代码生成并原样落库（多一种事件类型和一条投影规则；前缀只在压缩点失效一次）；B. 保持 §4.3 的逐步替换加滑动 N（不用改；越过阈值后每次运行都会让缓存失效，而且投影依赖预算配置）；C. 不压缩，到了硬上限就提示用户开新会话（最简单；长会话体验突兀） | A |
| R2-2 | 已结束运行的 thinking 怎么处理 | A. **带 tools 时全部保留**，计入预算，只在压缩时随整段运行一起折叠（上下文增长更快）；B. 按 §6.3a 去掉（按官方文档会 400，而且每次运行都有一个断点）；C. 重新考虑 D-41，关掉推理（省 token，但会推翻已经拍板的结论） | A（T09 用一次真实请求确认 B 确实会 400） |
| R2-3 | pi 消息在日志里怎么保真 | A. **`agent.message.payload` 加 `messageJson: string`（原样字节）**，projector 自己拼的 JSON 用规范序列化（要改 A-01 的事件 schema；存储大约翻倍）；B. 把 A-01 的 `payload` 列改成 `json` 类型（保留原文，但失去 jsonb 的索引和运算能力，影响 A-01 的 `events_quote_offered` 索引）；C. 只做规范序列化（键排序）（没用：运行期间 pi 发出去的是模型原始的键顺序，第一次运行和重放仍然对不上） | A |
| R2-4 | 运行期间到达的 `booking.*` 放在哪里 | A. **挂在下一次运行的边界上**（放在那次运行的 run_context 之前，只追加，不会拆开工具调用和结果）；B. 保持放在自己的 seq 位置（会在历史中间插入，可能拆开 tool_calls 和 tool 消息） | A |
| R2-5 | 要不要加 `get_quote(quoteId)` 找回工具 | A. **现在不加**，压缩摘要里保留 quoteId 加不带数字的路线，票据用 `list_my_tickets`（工具集不变；报价的细节找不回来）；B. 上线时就加（每个请求都多约 100 token 的 schema，多一个工具要评测；可以完整找回）；C. 以后需要时再加（会改变工具集，部署时所有会话的缓存失效一次） | A，评测里出现"问旧报价细节"的失败用例时再选 B |
| R2-6 | 水位线的默认值 | H = 40k（沿用 D-40）、L = 16k、至少保留 1 次完整运行、摘要最多 K = 20 条报价；可以配置。但改了配置，只影响以后的压缩事件，不改写已有的历史 | 采用这些默认值，评测后再调 |
| R2-7 | 前缀稳定和缓存命中率怎么验收 | A. **前缀性质测试和黄金往返测试作为 CI 硬门槛；命中率只在评测里报告**，目标是第 2 次及以后的请求 ≥ 80%（命中率受 DeepSeek best-effort 的影响，不适合当门槛）；B. 命中率也作为门槛（结果会因为厂商一侧的原因而波动，可能误报） | A |

---

## 7. 来源列表

- [ds-kv] DeepSeek API Docs, Context Caching / KV Cache：https://api-docs.deepseek.com/guides/kv_cache
- [ds-price] DeepSeek API Docs, Models & Pricing：https://api-docs.deepseek.com/quick_start/pricing
- [ds-think] DeepSeek API Docs, Thinking Mode：https://api-docs.deepseek.com/guides/thinking_mode
- [ds-news] DeepSeek 发布公告（2024-08-02，硬盘缓存，64 token 单元）：https://api-docs.deepseek.com/news/news0802
- [anthropic-ma] Anthropic Engineering, Scaling Managed Agents：https://www.anthropic.com/engineering/managed-agents
- [anthropic-ce] Anthropic Engineering, Effective context engineering for AI agents：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [anthropic-edit] Claude Docs, Context editing：https://platform.claude.com/docs/en/build-with-claude/context-editing
- [manus] Manus, Context Engineering for AI Agents: Lessons from Building Manus：https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- [openai-compact] OpenAI API Docs, Compaction：https://developers.openai.com/api/docs/guides/compaction
- [pg-json] PostgreSQL Docs, 8.14 JSON Types：https://www.postgresql.org/docs/current/datatype-json.html
- 项目内：`spikes/S-01/REPORT.md`（Q3、Q7、Q9）、`docs/design/A-02-agent.md` v0.3、`docs/design/A-01-frontend-backend.md`（events 表）

[ds-kv]: https://api-docs.deepseek.com/guides/kv_cache
[ds-price]: https://api-docs.deepseek.com/quick_start/pricing
[ds-think]: https://api-docs.deepseek.com/guides/thinking_mode
[ds-news]: https://api-docs.deepseek.com/news/news0802
[anthropic-ma]: https://www.anthropic.com/engineering/managed-agents
[anthropic-ce]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[anthropic-edit]: https://platform.claude.com/docs/en/build-with-claude/context-editing
[manus]: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
[openai-compact]: https://developers.openai.com/api/docs/guides/compaction
[pg-json]: https://www.postgresql.org/docs/current/datatype-json.html
