# W3 公共规则（所有 W3 任务都适用，各任务文档只写差异）

- 契约版本：**v1.0（已冻结）**，见 [CONTRACT-v1.md](../contracts/CONTRACT-v1.md)。规范来源和冲突优先级见 §1。
- DAG：[A-03 v1.1 §0](../planning/A-03-dag-and-session-roles.md)。本波次的任务之间**没有依赖边**；对其他任务的依赖一律用替身代替，到 W4 集成时再接真实实现。

## 工作区和版本控制（D-15）
1. 会话启动后的**第一件事**：在当前 worktree 里执行 `git branch -m task/<ID>`，把 app 自动起的分支名改成 `task/<ID>`。护栏 hook 靠这个分支名找到 `docs/tasks/<ID>.manifest`。然后执行 `git config core.hooksPath .githooks`（如果还没设置），再执行 `pnpm install --frozen-lockfile --offline`。
2. 只在 `task/<ID>` 分支（或者 `task/<ID>/<子块>`）上提交。**不推送，不合并**，合并由父会话完成。
3. 只能改 manifest 里列出的路径。pre-commit 会拦截越界改动，被误拦时要上报，**不能绕过**（禁止 `--no-verify`）。

## 不能做
- 改契约（`packages/contracts/**`、`docs/contracts/**`）、改依赖或 lockfile、改别的任务的文件、改 `docs/adr/`、`docs/planning/`。
- 自己做决策。遇到规范没覆盖的情况、需要取舍、或者和契约冲突时，**停下来**，按下面的格式上报父会话，然后等回复。
- 读取或打印 `.env` 和任何 secret 的值。

## 委派（R-U3）
- 任务负责人可以把**边界清楚、不需要了解太多实现细节**的子块交给 Sonnet 子 agent（`model: sonnet`）。例如：样板路由、一组测试、独立的纯函数、组件。
- 涉及状态、并发、安全边界的判断，由负责人自己做。
- 合并子块之前，负责人要亲自运行 `pnpm check`，并核对子块实际交付了什么，不能只看它的汇报。
- 如果某个子块需要跨多轮完成，或者需要人中途查看，可以 fork 一个会话。fork 出来的会话必须用自己的 worktree，分支为 `task/<ID>/<子块>`，由负责人合并回 `task/<ID>`。

## 完成标准
1. 在 `task/<ID>` 上，`pnpm check` 9 步全部通过。
2. 任务文档里每条验收标准都有证据：标准 → 命令 → 关键输出。
3. 在 `docs/tasks/<ID>.md` 末尾追加"汇报"一节，然后提交。

## 汇报格式（发给父会话，同时写进任务文档）
```
<ID> 状态：完成 / 阻塞
改动：<提交哈希>（分支 task/<ID>）
验收证据：标准 → 命令 → 关键输出
委派：哪些子块交给了 Sonnet，你怎么核对的
新发现：数据陷阱、契约问题、异常
需要父会话处理：契约变更 / 依赖申请 / 待决策
```
