# R-01 调研记录：pi 框架、Managed Agents 架构、可用开源组件

- 日期：2026-11-18
- 阶段：了解（human-in-the-plan §8.1）
- 说明：以下内容来自公开 README / 文章（2026-11-18 读取），**未在本地安装或运行验证**。标注"未验证"的项需在脚手架阶段（T0x）用代码确认。

---

## 1. pi 框架（earendil-works/pi，原 badlogic/pi-mono）

### 1.1 基本事实
| 项 | 结论 | 来源 |
|---|---|---|
| 仓库 | `github.com/earendil-works/pi`（`badlogic/pi-mono` 已重定向） | GitHub |
| npm scope | **`@earendil-works/*`**（旧 `@mariozechner/*` 的状态未验证，npm 页 403） | 各包 package.json |
| 许可证 | MIT | 根 README / package.json |
| Node 要求 | `>=22.19.0` | package.json engines |
| 版本 | main 分支 pi-ai / pi-agent-core 均为 `1.5.2`（**npm 实际发布版本未验证**） | package.json |

### 1.2 包清单与对我们的用途
| 包 | 作用 | 我们是否采用 |
|---|---|---|
| `pi-ai` | 统一多厂商 LLM API（流式、工具调用、token/成本统计、凭证注入） | **采用**（模型调用层） |
| `pi-agent-core` | Agent 循环 + 工具调用 + 事件流 + 钩子 | **采用**（harness 内核） |
| `pi-schema` | 工具参数 schema 构建器（pi-agent-core 依赖） | 间接采用 |
| `pi-telemetry` | 厂商中立的遥测契约（spans/metrics） | 可选（D-11） |
| `pi-durable` | 完整的"持久化 agent harness"（自带 transcript、任务循环、存储） | **不采用**，见 1.5 |
| `chord` | 跨进程对象运行时 / 插件热重载 | **不采用** |
| `pi-coding-agent` | 编码 CLI，含 SDK `createAgentSession()` 和 pi packages 扩展体系 | **不采用**，见 1.4 |
| `pi-tui` | 终端 UI | 不采用 |

### 1.3 pi-agent-core 关键 API（与我们架构的映射）
- `new Agent({ initialState: { systemPrompt, model, thinkingLevel, tools, messages }, streamFn, convertToLlm, transformContext, toolExecution, beforeToolCall, afterToolCall, prepareRequest, finishTurn, getApiKey, sessionId, ... })`
- 工具：`AgentTool = { name, label, description, parameters(JSON Schema), executionMode?: "sequential"|"parallel", execute(toolCallId, params, signal, onUpdate) → { content:[{type:"text",text}], details } }`；`execute` 抛错会被转成 `isError: true` 的工具结果。
- 事件：`agent_start/end, turn_start/end, message_start/update/end, tool_execution_start/update/end`；`subscribe(listener)` 的监听器**按注册顺序 await**。
- 钩子：
  - `beforeToolCall` → 可返回 `{ block: true, reason }` 拦截；注意 `tool_execution_start` **先于** 它触发。
  - `afterToolCall` → 可改写 details / 终止。
  - `prepareRequest` → 每次请求模型前调用，可从外部存储重建 messages。**这是"无状态 harness 从 session 日志重建上下文"的接入点。**
  - `finishTurn` → 决定继续或结束。
- 状态：`agent.state.messages` 只在内存，**无内置持久化**；可通过 `initialState.messages` 或 `prepareRequest` 重建（未见官方示例，**未验证**）。
- 无内置审批 / 权限系统。

**映射结论**：pi-agent-core 正好可以当 Managed Agents 里的 "harness loop"：
- session 日志由我们自己实现（Postgres 只追加表）；
- harness 每次被 `wake(sessionId)` 时 new 一个 Agent，用 `prepareRequest` 从日志重建上下文；
- 用 `subscribe` 把每条消息 / 工具事件 `emitEvent` 回日志；
- 每个 `AgentTool.execute` 内部只做一件事：`hands.execute(name, input)`（HTTP 调用 hands 进程）。

### 1.4 pi packages / 插件生态的适用性
- pi packages（npm/git 分发的 extensions/skills/prompts/themes）是 **pi-coding-agent 的功能**，只在 CLI 或 `createAgentSession()` SDK 里加载。直接用 pi-agent-core 时**拿不到这套扩展体系**。
- 社区安全类包（`pi-permission-gate`、`pi-simple-permissions`、`pi-sandbox`、`pi-permission-modes` 等）都面向**编码场景**：拦截 bash / 文件读写、bwrap / landlock 沙箱。我们的 agent **不暴露 shell 和文件工具**，这些包解决的不是我们的威胁。
- pi 官方 SECURITY.md 明确把"提示注入""沙箱""第三方扩展风险"列为**不在其安全范围内**；README 写明 pi 没有内置权限系统。→ 提示注入防护、授权、下单安全**完全是我们的责任**。
- pi 仓库自己的供应链实践：直接依赖精确锁版本、`min-release-age=2`、`npm ci --ignore-scripts`。**我们照搬**（见硬规则 H-09）。

**结论**：不引入任何第三方 pi package。安全控制用"架构 + 确定性代码"实现：
1. 工具集白名单、参数 schema 严格校验；
2. `beforeToolCall` 做策略检查；
3. 下单能力不在 harness 内（见 H-02）。

### 1.5 pi-durable 为什么不用
- README 标注 **Experimental，API 随时变**。
- 它自己拥有 transcript、任务状态和 agent 循环，和"session 与 harness 分离"冲突：它就是一个把两者合在一起的 harness。
- 存储只有 Memory / IndexedDB / SQLite / JSONL / Cloudflare DO，**没有 Postgres / Redis**。
- 明确是**单写者、无跨进程锁**，和"多个无状态 harness 按 sessionId 唤醒"冲突。
- 可借鉴的设计：`requestId` 幂等提交、replay-safe 工具崩溃后重跑、其他工具标记 `interrupted`、`restartLimit` 防崩溃循环。→ 吸收进我们的失败语义契约（结构层）。

---

## 2. Claude Managed Agents 架构（Anthropic Engineering, 2026-04-08）

| 组件 | 定义 | 关键接口 |
|---|---|---|
| **Session** | 只追加的事件日志，记录发生过的一切；独立于 harness 和 sandbox | `getSession(id)`、`getEvents()`（按位置切片）、`emitEvent(id, event)` |
| **Harness（brain）** | 调用模型、把工具调用路由到基础设施的循环；**状态可丢弃** | `wake(sessionId)` 拉起新 harness，从最后一个事件继续 |
| **Hands（sandbox / tools）** | 执行环境；harness 不关心它是容器、手机还是模拟器 | `execute(name, input) → string`、`provision({resources})` |

要点：
- 上下文以 session 日志为准；harness 取事件切片后**在 harness 内做变换**再送进模型（压缩、裁剪旧工具结果），并尽量提高 prompt cache 命中率。不可逆的丢弃要谨慎。
- **凭证永远不进 sandbox**：凭证放在 vault 里，工具调用经代理，代理用 session 关联的 token 去取凭证，"harness 从不知道任何凭证"。作者认为仅缩小 token 权限还不够，必须让 token 根本拿不到。
- hands 失败时当作工具错误返回给模型，必要时重新 provision；harness 失败时 `wake` 一个新的。
- 收益：不需要 sandbox 的会话不再付容器启动成本（文中给出 p50 TTFT 约 -60%、p95 超过 -90%，没有给基线）。
- 教训：单个容器变成"宠物"；可观测性不足，无法区分故障在 harness、网络还是容器；为某个模型加的 harness 补丁换模型后会变成累赘。

**对本项目的映射**
| Managed Agents | 本项目 |
|---|---|
| Session | `gateway` 进程拥有 `sessions` / `events` 表（Postgres，只追加），对外提供 REST + SSE |
| Harness | `harness` 进程（无状态 worker，可多副本），基于 pi-agent-core |
| Hands | `hands` 进程：航线引擎、城市解析、报价、查票。只有一个入口 `execute(name, input)` |
| Vault / 代理 | LLM key 只在 harness；订单库写凭证只在 booking 能力所在模块；harness 调 hands 用的是 session 级短期 token |
| wake | Redis 队列 `wake(sessionId)` + 每个 session 一把租约锁 |

---

## 3. 其他候选开源组件（初筛，需在依赖冻结时复核）

| 用途 | 候选 | 初步结论 |
|---|---|---|
| 提示注入检测 | hai-guardrails（TS，许可证标为 "other"）、PromptPurify、InjectShield（规则库，MIT，社区小）、LLM Guard（Python，据称 2026-07 起已停止维护） | **都不作为安全依赖**。我们的安全靠架构保证：LLM 没有下单能力，数字不由 LLM 产生。可以选一个做"可观测的辅助信号"（D-12） |
| 队列 / 唤醒 | BullMQ（Redis，MIT）、Redis Streams 原生 | 见 D-04 |
| 城市名模糊匹配 | 自写：Unicode NFD 去重音 + 小写 + 编辑距离；或 fuse.js | 倾向自写（几十行，可测，零依赖） |
| 反向代理 / HTTPS | Caddy（拿到域名后自动申请证书） | 推荐 |
| 可观测性 | OpenTelemetry + pi-telemetry；Langfuse 自托管（较重） | 见 D-11 |
| 参数校验 | pi-schema（pi 自带）/ zod | 契约包统一选一个（结构层定） |

## 4. 数据陷阱（`locations.db` 实测）
- sha256 = `fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f`（作为"原始数据不变"的校验基线）
- 711 城市 / 40 枢纽 / 151 条 hub_links；**40 个枢纽全部连通**；随机抽样的有服务城市对都可达。
- 无服务城市 10 个：Abu Dhabi, Stuttgart, Austin, Srinagar, Pokhara, Columbus, Savannah, Fort Lauderdale, Los Cabos, Iquitos。
- **坐标是虚构的**：比如 Austin 最近的有服务城市是 Copenhagen（120.95 km），Abu Dhabi 最近的是 Tirana。→ 必须按库算，LLM 的地理常识会"纠正"成错误答案。
- 35 个城市名含非 ASCII 字符（São Paulo、Zürich、Bogotá 等），其中 São Paulo、Bogotá 是枢纽。
- 坐标都是整数，没有重复坐标；非枢纽城市的 connected_hubs 数量分布：1 个 322 城、2 个 225 城、3 个 114 城、0 个 10 城。
- 因为是欧氏距离（满足三角不等式），**凡是有直飞的航段，直飞就是最便宜的**（实测 151 条 hub 链路 + 1114 条支线全部成立）。
- 换乘只能在枢纽：非枢纽城市只能做起点或终点，不能做中转。
- **平价路线（等价最便宜）的打平规则**题目没有规定 → 需要定一个确定性规则（D-09）。
- "有服务"的定义：枢纽，或 connected_hubs 非空的非枢纽城市。
- **规范化后重名（2026-11-18，A-02 验收时发现，父会话已用 python 复核）**：`San Jose`（2868,-1376，连接 Tokyo）和 `San José`（1054,-2282，连接 Sydney;Tokyo）是**两个不同的有服务城市**，去掉重音后完全相同。所以规范化匹配命中多个城市时，必须返回 `ambiguous` 让用户选，**绝不能随便选一个**；记忆里也只能存原始的 `city_name`。
- **NFKD 去不掉的字母**：`Tromsø`、`Wrocław` 里的 ø、ł 不是"字母 + 组合符号"，NFKD 分解不了。需要一张小的转写表（ø→o、ł→l、æ→ae、ß→ss 等）。

## 来源
- [earendil-works/pi（原 badlogic/pi-mono）](https://github.com/badlogic/pi-mono)
- [pi packages 注册页示例：pi-permission-gate](https://pi.dev/packages/@skibum1869/pi-permission-gate?page=67)、[pi-sandbox](https://pi.dev/packages/@yandy0725/pi-sandbox?name=pi-sandbox)、[pi-permission-modes](https://pi.dev/packages/pi-permission-modes?page=19)
- [Anthropic Engineering: Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
- [hai-guardrails](https://awesome.ecosyste.ms/projects/github.com%2Fpresidio-oss%2Fhai-guardrails)、[PromptPurify](https://blog.securelayer7.net/promptpurify-an-prompt-injection-firewall/)、[LLM Guard](https://appsecsanta.com/llm-guard)
