# W1 接缝划分：A-01 与 A-02 各自负责什么

- 日期：2026-11-18；作者：父会话
- 用途：A-01 和 A-02 并行写作时，避免两边都写、两边都没写、或者写得互相矛盾。
- 契约终稿由父会话合并（"契约 v1"），设计会话只写**草案**。

## 1. 归属表
| 接缝 | 负责方 | 另一方怎么用 |
|---|---|---|
| 进程清单、compose 网络分段、每个容器能拿到的凭证和环境变量 | **A-01** | A-02 引用，并提出 harness / hands 的具体需求 |
| 浏览器 ↔ gateway 的 REST / SSE 接口、CSRF、cookie 会话 | **A-01** | — |
| Postgres 表结构、每个服务的数据库角色和授权、谁能写哪张表 | **A-01** | A-02 提出 events / quotes / memories 需要哪些字段 |
| **事件信封**（`seq`、`session_id`、`type`、`ts`、`trace_id`、`payload`）和**持久化规则**（哪些事件落库、哪些只走 Redis 推送） | **A-01** | A-02 在这个信封里定义 agent 侧的事件类型 |
| **事件类型目录**：用户侧和系统侧事件（`user.message`、`quote.offered` 的渲染要求、`booking.confirmed` / `booking.failed`、`session.status`） | **A-01** | — |
| **事件类型目录**：agent 侧事件（`agent.message`、`agent.delta`、`agent.tool_call`、`agent.tool_result`、`agent.error`、`harness.lease` 等） | **A-02** | A-01 的前端按它来渲染 |
| session 内部 API（`getEvents` / `emitEvent` / `wake`）：**HTTP 形状、鉴权、分页** | **A-01** | A-02 定义它对这个 API 的调用时机和语义需求 |
| session 内部 API：**调用时机、幂等键、租约语义** | **A-02** | A-01 按这些需求实现 |
| hands 的 `execute(name, input)` 信封：请求、响应、错误、session token | **A-02** | A-01 把它放进拓扑和鉴权 |
| 每个工具的名字、参数 schema、返回结构 | **A-02** | A-01 的前端只关心 `offer_booking` 产生的报价卡数据 |
| 确认下单链路：按钮 → gateway → booking（校验项、幂等、错误码） | **A-01** | A-02 保证 agent 侧没有任何下单途径，并说明 agent 怎么感知 `booking.confirmed` |
| 报价（quote）的数据结构和不可变规则 | **A-02** 定字段（由领域计算产生）；**A-01** 定存储和归属 | — |
| 长期记忆：数据表和用户查看 / 删除的接口 | **A-01** | — |
| 长期记忆：写入规则、召回、注入上下文的方式、防注入 | **A-02** | — |
| 中英双语：界面文案和 i18n 方案 | **A-01** | — |
| 中英双语：对话语言策略、中文城市名怎么映射到库里的城市名 | **A-02** | — |
| 可观测性：traceId 透传、日志格式、预留 OTel 接口 | **A-01** | A-02 补充 harness 的 span 划分 |
| 评测方法：航线对拍、确认流程、红队、记忆 | **A-02** | A-01 补充前端和 E2E 的部分 |

## 2. 冲突处理
- 发现**归属表里没有的接缝**，或者需要另一方配合改动：写进自己文档的"接缝问题"一节，然后 SendMessage 给父会话，**停下来等回复**。
- 不要直接改对方的文档。不要和对方会话私下商量着定。
