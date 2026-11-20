# W4 公共规则（T12a、T12b）

- 契约版本：**v1.1.1**（[CONTRACT-v1.md](../contracts/CONTRACT-v1.md)）。本波次没有改行为，只加了 M-25（`score` 保留 4 位小数，代码里已经如此）。
- 本波次只做联调。部署（T14）、端到端（T15）、评测（T13b）还没派发，不要提前做。
- 工作区：父会话已经建好 worktree 和 `task/<ID>` 分支。只在自己的分支上提交。不推送，不合并。
- 先确认 `git config core.hooksPath` 指向 `.githooks`（worktree 里可能是主仓库 `.githooks` 的绝对路径，只要跑的是这套 hook 即可）。需要时执行 `pnpm install --frozen-lockfile`。
- 只能改 manifest 里的路径。被 hook 拦住时上报，禁止 `--no-verify`。
- 不能改契约、依赖、lockfile，不能读或打印 `.env` 和 secret 的值。
- 遇到规范没覆盖的取舍，先做完其余部分，把问题写进汇报的"需要父会话处理"，不要自己拍板。
- 完成标准：`pnpm check` 9 步通过；每条验收标准有命令和关键输出；汇报追加到 `docs/tasks/<ID>.md` 末尾并提交。
