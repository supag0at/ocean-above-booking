# S-01 报告：pi 无状态 spike

- 日期：2026-11-18；Node v22.23.5 / npm 10.9.9（Windows 10）
- 依赖：`@earendil-works/pi-agent-core@1.5.2`、`@earendil-works/pi-ai@1.5.2`，Q9 追加了 `typebox@1.4.7`、`fastify@5.12.8`（精确版本，`npm install --ignore-scripts`，间接带入 `pi-schema@1.5.2`、`pi-telemetry@1.5.2`）
- 模型：`deepseek-flash`（DeepSeek-V4.1-Flash），除特别说明外 `thinkingLevel: "off"`
- 运行方式：Node 22.18+ 默认支持类型剥离，直接 `node src/xxx.ts`，不需要 tsx/tsc
- API 调用：总共 **22 次**（上限 50；Q1–Q8 用了 19 次，Q9 用了 3 次），明细见 `out/api-calls.log`（每次请求由 `onPayload` 记一行）
- 密钥：`src/lib.ts` 只从 `../../.env` 读 `DEEPSEEK_API_KEY` 到 `process.env`，不打印；所有日志和 payload 落盘前经过 `redact()`。已核对 `out/`、`src/` 里既没有密钥原文，也没有 `sk-…` 形式的字符串（两次 grep 均为 0 个文件）
- 每次请求的原始 payload 存在 `out/<脚本>.payload-N.json`（已打码；`out/` 在 `.gitignore` 里）

所有命令都在 `spikes/S-01/` 下执行。

---

## Q1 包名、版本和 Node 要求

```bash
npm view @earendil-works/pi-agent-core version engines dependencies --json
npm view @earendil-works/pi-ai version engines --json
npm view @mariozechner/pi-agent-core version engines deprecated --json
```
关键输出：
```
@earendil-works/pi-agent-core  1.5.2  engines.node ">=22.19.0"  deps: pi-ai 1.5.2, pi-schema 1.5.2   (发布于 2026-11-10T12:20Z)
@earendil-works/pi-ai          1.5.2  engines.node ">=22.19.0"  deps: openai 7.19.0, @anthropic-ai/sdk 0.129.0, @google/genai 2.21.0, aws bedrock, pi-schema, pi-telemetry …
@earendil-works/pi-schema      1.5.2  engines.node ">=22.19.0"
@mariozechner/pi-agent-core    0.73.1 engines.node ">=20.0.0"  deprecated: "please use @earendil-works/pi-agent-core instead going forward"   (最后修改于 2026-05-07)
@mariozechner/pi-ai            0.73.1 同样已弃用，依赖 typebox ^1.1.24
```
结论：R-01 里标"未验证"的几项都成立。npm 上的最新版就是 1.5.2，和 main 分支一致；1.5.2 发布已经 8 天，满足 `min-release-age=2`。旧的 `@mariozechner/*` 停在 0.73.1，已标记 deprecated，不能用。Node 要求 `>=22.19.0`。
注意：pi-ai 会把所有厂商的 SDK 都装进来（openai、anthropic、google、bedrock），即使我们只用 DeepSeek。`npm install` 后报告 0 个漏洞。

## Q2 DeepSeek provider 配置、model id、流式、工具调用

配置方式（见 `src/lib.ts`）：
```ts
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
const models = createModels(); models.setProvider(deepseekProvider());
const model = models.getModel("deepseek", "deepseek-flash");
new Agent({ initialState: { model, ... }, streamFn: models.streamSimple.bind(models) });
```
`deepseekProvider()` 固定使用 `baseUrl: https://api.deepseek.com`、`api: openai-completions`，密钥从环境变量 `DEEPSEEK_API_KEY` 读（`envApiKeyAuth`）。`streamFn` 是**必填项**。

```bash
node src/q2-models.ts      # GET /models，1 次
node src/q3a-run.ts        # 流式输出 + 工具调用，2 次
```
关键输出：
```
[q2-models] {"status":200,"body":{"data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash","context_window":1048576,"max_output_tokens":393216,"effort":{"supported_levels":["low","high","max"],"default_level":"high"}...},{"id":"deepseek-v4-pro",...}]}}
[q3a.events] agent_start > turn_start > message_start > message_end > message_start > message_end > tool_execution_start > tool_execution_end > message_start > message_end > turn_end > turn_start > message_start > message_end > turn_end > agent_end
[q3a.textDeltas] 18
[q3a.messages] ... {"role":"assistant","stop":"toolUse","content":["toolCall:get_weather({\"city\":\"Paris\"})#call_00_ACRP…"]},{"role":"toolResult",...,"isError":false} ... "text:Paris is 17°C and cloudy right now. Nice to meet you, Lin."
```
结论：
- Flash 档的确切 model id 是 **`deepseek-flash`**。API 返回的列表和 pi 自带目录（`dist/providers/data/deepseek.json`）一致，目录里只有 `deepseek-flash` 和 `deepseek-v4-pro` 两个。
- 流式输出正常：收到 18 个 `text_delta`，请求带了 `stream_options.include_usage`。工具调用正常，参数是解析好的对象。
- 实际发出的请求（`out/q3a.payload-2.json`）：`thinking:{type:"disabled"}`、`max_tokens:384000`（默认等于目录里的 maxTokens）、工具带 `"strict": false`、assistant 消息带 `reasoning_content:""`。

## Q3 上下文重建（跨进程）

```bash
node src/q3a-run.ts                  # 进程 A：带工具调用的一轮对话 → out/q3-messages.json
node src/q3b-resume.ts initial       # 进程 B：initialState.messages = JSON
node src/q3b-resume.ts prepare       # 进程 B'：Agent 状态为空，prepareRequest 每次注入"日志"（JSON + 用 subscribe 追加的新消息）
node src/q3a-run.ts low && node src/q3b-resume.ts initial low   # 同样的流程，打开 thinking
```
进程 B 的问题是"不调用工具，说出我的名字、颜色、问的城市、工具返回的 code"。关键输出：
```
[q3b-initial.answer]  "- Name: Lin - Favourite colour: teal - City asked about: Paris - Weather code: WX-4417"
[q3b-initial.pairing] {"ok":true,"calls":["call_00_ACRP…"],"results":["call_00_ACRP…"],"orphans":[]}
[q3b-initial.sentRoles] ["system","user","assistant[tool_calls:call_00_ACRP…]","tool[call_00_ACRP…]","assistant","user"]
[q3b.prepareRequest.incoming] [{"role":"system","text":""},{"role":"user",...}]     ← Agent 自己内存里的上下文
[q3b-prepare.answer]  同上，四项全对
[q3b-prepare.agentStateLen] 3          ← agent.state.messages 只有 3 条，和真正发出去的 6 条不一致
[q3b-initial-low] 四项全对；重放的 assistant 消息带 reasoning_content（长度 41），请求为 thinking:{type:"enabled"}, reasoning_effort:"low"
```
结论：**两种方式都能用**。`AgentMessage[]` 是纯 JSON，`JSON.stringify` 存、`JSON.parse` 取不会丢信息，工具调用 id 和结果的配对也保持正确。打开 thinking 时，thinking 块（`reasoning_content`）同样能从 JSON 原样重放，DeepSeek 不报错。
需要注意的几点：
1. **系统提示词和工具声明都在 transcript 里**：`messages[0]` 是 `{role:"system", content, toolsAdded:[…工具 schema]}`。每次请求前，循环会拿 `state.tools` 和 transcript 里声明的工具做比对，有差异就**追加一条 system 消息**（`toolsAdded`/`toolsRemoved`），这条消息会走 `message_start/end` 事件。所以 session 日志**必须保存 system 消息**，否则重放出来的工具声明就不对。
2. 用 `prepareRequest` 方式时，`agent.state.messages` 和实际发给模型的内容会分叉：工具差异是和内存状态比的，不是和日志比的；`continue()` 判断"末尾是不是 assistant"看的也是内存状态。**建议以 `initialState.messages = 日志` 作为主路径**，`prepareRequest` 只用来做裁剪或压缩。

## Q4 工具执行中途崩溃

```bash
node src/q4-driver.ts                  # 启动子进程，等 slow_tool(30s) 开始执行后 SIGKILL 子进程
node src/q4b-recover.ts continue       # 原样恢复后调用 agent.continue()
node src/q4b-recover.ts prompt         # 原样恢复后发一条新的用户消息
node src/q4b-recover.ts interrupted    # harness 先补一条 interrupted 的 toolResult，再调用 continue()
```
关键输出：
```
[q4-driver] child killed during slow_tool: code=null signal=SIGKILL
[q4-driver] event log at crash:  message user / message assistant stop=toolUse ["call_00_8n8O…"] / tool_execution_start call_00_8n8O…
=== continue
[q4b-continue.threw] Cannot continue from message role: assistant        （0 次请求，工具没有重跑）
=== prompt
[q4b-prompt.sentToolMsgs] [{"role":"tool","content":"No result provided","tool_call_id":"call_00_8n8O…"}]
[q4b-prompt.result] "The job call returned no result — no receipt id, no error detail. So I can't confirm it ran or completed. Your order reference is ZX-12."
=== interrupted
[q4b-interrupted.sentToolMsgs] [{"role":"tool","content":"interrupted: the worker crashed while slow_tool was running (started=true). Outcome unknown; it was NOT confirmed. Ask the user before retrying.", ...}]
[q4b-interrupted.result] "The job started but the worker crashed mid-run — the outcome is unconfirmed, so I won't retry without your go-ahead. Want me to run it again?"
三种方式都是 toolReExecuted=false
```
结论：
- 崩溃时日志里的状态是：assistant 消息（含 toolCall）已经写入（Agent 类会等 `message_end` 处理完才开始工具预检），`tool_execution_start` 也写入了，但没有结果。
- pi **不会重跑工具，也不会报"缺少结果"的错**，具体行为分两种：
  - 末尾是 assistant 时调用 `continue()` 会直接抛错 `Cannot continue from message role: assistant`，不发请求。
  - 有新的用户消息时，pi-ai 的 `transformMessages` 会**悄悄补一条**合成的 `toolResult`，内容是 `"No result provided"`、`isError:true`。这条只出现在发出去的请求里，**不写回 transcript**，也不触发事件。
- 所以**需要我们自己补 `interrupted` 结果**：wake 的时候发现"有 toolCall 但没有 toolResult"，就先往日志追加一条明确的 interrupted toolResult（写明结果未知，不要自动重试），然后调用 `continue()`。这样语义可控，日志里也能看到，模型的回应也符合预期（先问用户，不直接重试）。

## Q5 `beforeToolCall` 拦截

```bash
node src/q5-block.ts
```
关键输出：
```
[q5.order] ["event:tool_execution_start(call_00_6uWa…)",
            "hook:beforeToolCall(call_00_6uWa…, args={\"city\":\"Oslo\"})",
            "event:tool_execution_end(call_00_6uWa…, isError=true)",
            "event:message_end(toolResult isError=true)"]
[q5.toolExecuteCalled] false        （afterToolCall 也没有被调用）
[q5.sentToModel] [{"role":"tool","content":"POLICY_BLOCK: weather lookups are disabled for this session.","tool_call_id":"call_00_6uWa…"}]
[q5.transcriptTail] … "Weather lookups are blocked for this session, so I can't get Oslo's conditions."
```
结论：
- **`tool_execution_start` 确实先于 `beforeToolCall` 触发**（源码 `agent-loop.js` 也是先 emit 再 prepareToolCall）。所以 UI 和日志不能把 `tool_execution_start` 当作"工具已经执行"。被拦截的调用也会走完一组 start/end 事件，`isError=true`。
- 模型收到的**只有 `reason` 这段文字**，作为一条普通的 `role:"tool"` 消息。DeepSeek（openai-completions）的请求里**没有 isError 字段**，不写 reason 时默认是 `"Tool execution was blocked"`。参数会先经过 schema 校验再进 `beforeToolCall`，校验失败的调用不会进钩子。

## Q6 参数 schema 和 strict

```bash
node src/q6-strict.ts offline                                       # 0 次请求：pi-schema 校验和类型转换
node src/q6-strict.ts strict-require                                # constrainedSampling strict:'require'，默认 baseUrl
node src/q6-strict-probe.ts                                         # 原始请求：故意用一个 strict 下不合法的 schema，strict=true 和 false 各一次
node src/q6-strict-probe.ts https://api.deepseek.com/beta only-true # 同一个 schema 发到 /beta
node src/q6-strict.ts strict-beta                                   # pi + baseUrl=/beta + strict:'require'
```
关键输出：
```
[q6.validate.ok]  {"in":{"adults":"2",...},"out":{"adults":2,...}}                   ← 字符串数字被转成整数
[q6.validate.err] adults: expected >= 1  |  cabin: expected one of ["economy","business"]  |  extra: unknown field
[q6-strict-require.sentTool] {... "strict":true}   errorMessage=null（请求被接受）
[q6-probe.strict=true]  200 （默认端点：required 和 properties 不一致、additionalProperties:true 的 schema 也能通过）
[q6-probe.strict=false] 200
[q6-probe[https://api.deepseek.com/beta].strict=true] 400 "Required properties must match all properties in the object"
[q6-strict-beta] 请求被接受（minLength/minimum/maximum/enum 在 /beta 的 strict 模式下也合法）
```
结论：
- **用 pi-schema**（`obj/str/int/…`，pi-agent-core 1.5.2 直接依赖它）。`obj()` 默认是封闭的（`additionalProperties:false`，所有字段 required），会带出 `Static` 类型，校验会先做类型转换。pi 1.5.2 已经**不依赖 TypeBox**（旧的 0.73 才依赖）。README 说参数可以是任何 JSON Schema（包括 TypeBox 生成的），但 TypeBox 没装，所以**没验证**。手写 JSON（比如 `{type:"string",enum:[…]}`）可以和 builder 混用，已验证可用。
- **strict**：pi 的目录里 `deepseek-flash` 标了 `supportsStrictMode:true`，会发 `strict:true`。但**默认端点 `https://api.deepseek.com` 会悄悄忽略 strict**：不合法的 schema 也返回 200，说明根本没做约束解码。**只有 `https://api.deepseek.com/beta` 真正处理 strict**（会校验 schema 并返回 400）。所以 `strict:'require'` 在默认 baseUrl 下会给人一种已经强制约束的**错觉**。要用 strict，必须把 model 的 `baseUrl` 改成 `/beta`（`{ ...model, baseUrl: "https://api.deepseek.com/beta" }` 已验证可用）。
- 无论用不用 strict，pi 在执行前都会用 pi-schema 校验参数，校验失败就作为工具错误返回给模型，**这一层才是可靠的保证**。

## Q7 usage 和成本

`q3a` 的输出（另见 `q3a-low`）：
```
{"input":316,"output":38,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":354,"cost":{"input":0.0000948,"output":0.0000456,"total":0.0001404,"totalFromProvider":false}}
{"input":261,"output":18,"cacheRead":128,...,"totalTokens":407,"cost":{...,"cacheRead":7.68e-7,"total":0.000100668,"totalFromProvider":false}}
thinking=low：{"input":341,"output":49,"reasoning":10,...}
```
结论：token 字段可用，包括 `input`（不含缓存命中部分）、`output`、`cacheRead`（DeepSeek 的前缀缓存会正确映射过来，第二次请求就有 128/256 命中）、`reasoning`（打开 thinking 时才有）、`totalTokens`。**成本是 pi 按目录单价估算的**（$0.3/M 输入、$1.2/M 输出、$0.006/M 缓存读），`totalFromProvider:false`，DeepSeek 不返回计费金额。所以单价要和 DeepSeek 官方价格表核对，这次没有核对。

## Q8 坑和对 A-02 的建议

坑：
1. **strict 静默失效**（见 Q6）：默认 baseUrl 不强制约束。要么切到 `/beta`，要么不依赖 strict，以 pi-schema 校验为准。
2. **`tool_execution_start` 早于 `beforeToolCall`**，被拦截的调用也会发 start/end 事件。日志和 UI 要以 `tool_execution_end` 和 toolResult 消息为准。
3. **发给 DeepSeek 的工具消息不带 isError**，模型只能从文字判断成败。拦截原因和错误信息里要写清楚，比如统一加 `ERROR:` 或 `BLOCKED:` 前缀。
4. **缺失的工具结果会被 pi-ai 悄悄补成 "No result provided"**，而且不进 transcript。harness 应该在 wake 时自己补 `interrupted`，不要依赖这个隐式行为。
5. **末尾是 assistant 时不能 `continue()`**（会抛错）。wake 只有在日志末尾是 user 或 toolResult（或者有排队的输入）时才有事可做。
6. **system 消息就是 transcript 的一部分**（提示词和 `toolsAdded` 工具声明），工具集一变就会追加一条 system 消息。日志要记 system 消息；改工具集或提示词会产生新事件，也会影响 prompt cache。
7. **`prepareRequest` 会造成内存状态和日志分叉**（见 Q3）。主路径用 `initialState.messages`。
8. `max_tokens` 默认是 384000（等于目录里的 maxTokens），应该显式设一个合理的上限。另外 `streamFn` 必填；pi-ai 会把所有厂商的 SDK 一起装进来。
9. `thinkingLevel` 只有 `low/high/max` 能映射到 DeepSeek（`minimal`/`medium` 映射为 null）；默认是 off（`thinking:{type:"disabled"}`）。
10. 请求默认带 pi 的 attribution 头（`identity` 默认值）。如果不想暴露，就传 `identity: null` 或我们自己的值（这次没有测）。

对 A-02 的建议：
- harness 的 wake 流程：读日志 → 过滤出 `AgentMessage[]`（包括 system）→ 检查孤立的 toolCall，有就追加 interrupted toolResult 事件 → `new Agent({ initialState:{ model, tools, messages }, streamFn, sessionId })` → 末尾是 user 或 toolResult 就 `continue()`，有新输入就 `prompt(msg)` → 用 `subscribe` 把每个 `message_end` 以及工具事件追加到日志（listener 会被 await，可以当作写入屏障）。
- 工具定义统一用 pi-schema 的 `obj()`。是否用 strict 由 A-02 决定：要用就把 baseUrl 改成 `/beta`（DeepSeek 把它标为 beta，有稳定性风险）。
- `beforeToolCall` 做策略检查，`reason` 写成模型能看懂的固定格式。
- 成本统计用 pi 的 usage token 字段乘我们自己核对过的单价，不要直接用 `cost.total`。

## Q9 TypeBox 和 pi-schema 作为契约 schema 库（追加任务）

新增依赖：`typebox@1.4.7`、`fastify@5.12.8`（精确版本，`--ignore-scripts`，发布时间都超过 2 天）。本节用了 3 次 API 调用（q9-live 2 次 + q9-beta-probe 1 次），累计 **22/50**。

测试用的 schema：
```ts
Type.Object({ from: Type.String({minLength:1}), to: Type.String({minLength:1}),
  adults: Type.Optional(Type.Integer({minimum:1, maximum:9})), extra: Type.Optional(Type.Never()) },
  { additionalProperties: false })
```

### 9.1 TypeBox schema 直接作为 `AgentTool.parameters`
```bash
node src/q9-offline.ts   # 0 次请求：直接调用 pi 的 validateToolArguments（pi-agent-core 内部也是调用它）
node src/q9-live.ts      # 2 次请求：用 Agent 跑一次，并检查 DeepSeek 实际收到的工具定义
```
关键输出：
```
q9.typebox.ownKeys ["type","required","properties","additionalProperties","~kind"]   ← "~kind" 是不可枚举的，JSON.stringify 时不会输出
q9.typebox.JSON    {"type":"object","required":["from","to"],"properties":{…,"extra":{"not":{}}},"additionalProperties":false}

pi 接受 valid / valid+adults                         （没有转换）
pi 拒绝 extra field        "- foo: unknown field"
pi 拒绝 extra (never)      "- extra: must not match the schema in not"
pi 拒绝 missing to / empty from
pi 接受 from=1             → "1"     ⚠ 静默转换 number→string
pi 接受 from=true          → "true"  ⚠ 静默转换 boolean→string
pi 接受 adults="2"         → 2       ⚠ string→integer
pi 接受 adults=2.5         → 2       ⚠ 静默截断小数（会丢信息）
pi 接受 adults=null        → 字段被删掉
（同样这些输入，用 TypeBox 的 Value.Check 直接检查原始参数，全部返回 false）
pi-schema 的 int() 也一样：{n:2.5} → 2，{n:"2.9", s:1} → {n:2, s:"1"}

[q9-live.sentEqualsTypeBoxJSON] true      ← DeepSeek 收到的 parameters 和 JSON.stringify(TypeBox schema) 逐字节一致
[q9-live.sentStrictFlag] false
[q9-live.beforeToolCall] {"raw":{"from":"Rome","to":"Oslo","adults":2},"coerced":{…同上},"rawStrictCheck":true}
[q9-live.executedWith] {"from":"Rome","to":"Oslo","adults":2}   → 模型最后回答 "Rome → Oslo: direct flight, 2h, for 2 adults."
```
结论：
- **TypeBox 生成的 schema 可以直接用**。pi 的校验能正确执行 `additionalProperties:false`、`not`、`required`、`minLength` 这些约束，发给 DeepSeek 的定义和 TypeBox 输出完全一致，TypeBox 的内部标记 `~kind` 不会泄露出去。
- **静默转换是 pi 的行为，和用哪个 schema 库无关，而且关不掉**：`validateToolArguments` 每次都先做转换（源码 `pi-ai/dist/utils/validation.js`，没有任何开关）。最需要注意的是**小数会被截断成整数**（2.5→2），数字或布尔会被转成字符串。
- 缓解办法（已验证可行）：`beforeToolCall` 能拿到两份参数，`toolCall.arguments` 是模型给的原始参数，`args` 是转换后的。在钩子里对原始参数做一次严格检查（`Value.Check(schema, toolCall.arguments)`），不通过就 block。用 TypeBox 做这件事很方便（还有 `Value.Errors` 可以给出错误信息）。
- 类型方面（来自 pi README，没用 tsc 验证）：`parameters` 用 pi-schema 构建时，`execute` 的 `params` 会自动带上类型；用 TypeBox 时 `params` 是 `unknown`，需要用 `Static<typeof X>` 自己标注。

### 9.2 同一个 TypeBox schema 用于 Fastify 路由校验
```bash
node src/q9-fastify.ts   # 0 次请求，用 fastify.inject
```
关键输出：
```
[typebox/default-ajv]  extra field → 200 {"from":"Rome","to":"Oslo"}   ⚠ 多余字段被悄悄删掉了（Fastify 默认 removeAdditional）
[typebox/default-ajv]  from=1      → 200 {"from":"1"}                  ⚠ 默认 coerceTypes
[typebox/default-ajv]  adults="2"  → 200 adults=2；adults=2.5 → 400；extra:"x" → 400；missing to → 400
[typebox/strict-ajv]   （customOptions: {coerceTypes:false, removeAdditional:false}）
                       valid → 200；extra field / extra(never) / from=1 / adults="2" / adults=2.5 / missing to → 全部 400
[pi-schema/strict-ajv] 结果和 typebox/strict-ajv 完全一致
```
结论：**能用**，同一个 schema 对象直接放进 `schema.body` 就行。但 **Fastify 默认的 ajv 配置会转换类型并删掉多余字段**，`additionalProperties:false` 因此不会报错。契约层要求严格时，必须设置 `ajv.customOptions = { coerceTypes: false, removeAdditional: false }`。

### 9.3 pi-schema 能否导出为普通 JSON Schema
```
q9.pischema.ownKeys       ["type","properties","required","additionalProperties"]   （没有隐藏键）
q9.pischema.isPlainObject true；JSON 序列化再解析后完全一致：true
q9.pischema.JSON          {"type":"object","properties":{…},"required":["from","to"],"additionalProperties":false}
TypeBox 的 Value.Check 也能直接用这个 schema 校验：valid=true，extra=false；Fastify strict 下的表现和 TypeBox 一致（见 9.2）
```
结论：**能导出**。pi-schema 的 builder 返回的本来就是普通 JSON Schema 对象，不需要额外导出步骤，可以直接给 Fastify 或前端（`JSON.stringify` 即可）。

### 9.4 strict 模式下的兼容性（附带发现）
```bash
node src/q9-beta-probe.ts   # 1 次请求：把这个 TypeBox schema 发到 /beta，strict:true
```
```
400 "Invalid tool parameters schema : one of `type`, `anyOf`, `$ref` field is required"
```
`Type.Never()` 生成的 `{not:{}}` 过不了 DeepSeek 的 strict 模式。结合 Q6 的结果（strict 要求 `required` 包含全部属性），**如果要在 /beta 上用 strict**，工具 schema 里就不能有 optional 字段（要改成 nullable），也不能用 `Never`。这一点对 TypeBox 和 pi-schema 是一样的限制。

### 9.5 结论：**推荐 TypeBox**（pi-schema 也能用，没有硬伤）
证据和理由：
1. 两者在 pi、DeepSeek、Fastify 三个环节表现**完全一样**：输出都是普通 JSON Schema，pi 和 Fastify strict 下的校验结果逐项一致（9.1–9.3）。所以选哪个不影响功能。
2. 契约包要同时给 gateway、hands、booking（Fastify）和前端用。TypeBox 是 Fastify 生态的标准选择（有 type provider），而且自带独立于 pi 的严格校验器（`Value.Check`/`Value.Errors`）。我们需要它在 `beforeToolCall` 里对原始参数做严格检查，用来抵消 pi 关不掉的转换（9.1），在 hands 和 booking 的入口也要用。pi-schema 本身不提供"不做转换的校验"入口（`validateToolArguments` 总是先转换）。
3. pi-schema 的版本和 pi 1.5.x 绑在一起。把它当契约库，等于让 booking、前端这些和 pi 无关的模块也依赖 pi 的发版节奏。
4. TypeBox 的代价：pi 工具的 `params` 类型要用 `Static<>` 手动标注（来自 README，没验证）。
- 不管选哪个都必须做的事：Fastify 配置 `coerceTypes:false, removeAdditional:false`；harness 在 `beforeToolCall` 里对原始参数做严格检查；不要依赖 pi 的转换结果，尤其是小数会被截断。

## 文件
- `src/lib.ts`：加载密钥、打码、统计调用次数、捕获 payload、假工具（`get_weather`、`slow_tool`）、配对检查
- `src/q2-models.ts`、`src/q3a-run.ts`、`src/q3b-resume.ts`、`src/q4-driver.ts`、`src/q4a-crash-child.ts`、`src/q4b-recover.ts`、`src/q5-block.ts`、`src/q6-strict.ts`、`src/q6-strict-probe.ts`、`src/q9-offline.ts`、`src/q9-live.ts`、`src/q9-fastify.ts`、`src/q9-beta-probe.ts`
- `out/`（已 gitignore）：payload、日志、事件日志 JSONL、`api-calls.log`
