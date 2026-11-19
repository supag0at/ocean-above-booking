# 契约 CHANGELOG

## v1.0.2（2026-11-19，父会话，澄清）
- M-23：数字守卫的窗口归属规则、语言判断的分母和显式偏好、hands 超时、`save_preference` 的中文值、OSA 编辑距离、相对时间、作废一条打码断言。来源是 T13a 的评测用例审查。
- 受影响的会话：T03（⑤）、T08（③④）、T09（①②③⑦），均已广播。

## v1.0.1（2026-11-19，父会话，澄清，不改变行为）
- M-22：明确打平规则里的"字典序"是按 Unicode 码点比较，不用 localeCompare；priceCents 用 Math.round；平局容差 1e-6；只算简单路径。
- 受影响的会话：T03（已广播）、T08。

## v1.0（2026-11-19，G1 冻结）
- 用户确认冻结。从 rc3 到 v1.0 只修了表格格式，内容没有变化。

## v1.0-rc3（2026-11-19，父会话）
- T01 由 4 个 Sonnet 子块起草（提交 c5af5e2），父会话处理了它们提出的 TODO(T01-REVIEW)，结论记为 M-11 到 M-20：
  - 契约包各入口按层次引用；
  - 每个类型只保留一个定义来源；
  - 前端不能计算价格；
  - 修正 M-6 的笔误；
  - 不使用 `format`；
  - `agent.message` 改成按 role 区分的联合类型；
  - 补齐 `escapeUserText`；
  - 数据库的几处细节。
- depcruise 新增两条规则：`contracts-flight-direction`、`contracts-tools-direction`；`contracts-forbidden` 只检查 `src/`。
- CT-07 交给 T02 platform，CT-12 交给 T09。
- 发现 DAG 里漏了一个任务：`packages/platform` 没有分配负责人。现补为 **T02 platform**，放进 W2，和 T01 的整合并行进行。

## v1.0-rc2（2026-11-19，父会话）
- M-2 和 M-4：过程区和 reasoning **不打码**（用户原话："不需要打码"）。`processText` 存原文；去掉 `MASK_TOKEN`；A-02 §8.7 和 A-01 A2-17 作废。
- 受影响的会话：没有正在运行的设计会话（A-01、A-02 已经结束，不再修改，以本文为准）。T01 和 T09 按 rc2 实现。
- 新增局限（写进最终设计文档）：过程区和推理文本里可能出现模型自己估算的、未经核实的数字。缓解办法是界面标注"中间过程，不作为报价依据"，并且报价卡是唯一权威来源。

## v1.0-rc1（2026-11-19，父会话）
- 把 A-01 v0.6 和 A-02 v0.6 合并成 [CONTRACT-v1.md](CONTRACT-v1.md)。
- 两份文档之间剩下的差异，裁定为 M-1 到 M-10：
  - 带工具调用的消息落库之后，显示成 `process`；
  - 新增 `processText` 字段，存打码后的文字；
  - `reasoning_delta`；
  - 守卫只保留两种 action；
  - 幂等键带上 runId；
  - jobId；
  - 消费跟踪列；
  - trace 头；
  - `AGENT_DELTA_MODE` 默认是 `stream`。
- 全局常量放在 §3，契约测试 CT-01 到 CT-12 放在 §4。
- 原来的 T05（数据库 schema）并入 T01（A-03 v1.1）。
- 受影响的会话：A-01 和 A-02 的设计阶段已经结束，不再改文档，M-1 和 M-2 以本文为准。之后的 T01、T03 到 T11 都按本文开发。
- 等 G1 由人冻结成 v1.0。
