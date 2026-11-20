# W4 后半：部署 → 端到端 → 评测

用户原话（2026-11-20）：「可以不错。开始部署和端到端，最后跑评测。」

顺序按这句话，不按 DAG 里 T15 和 T13b 并行：

1. **T14** 现在派。做出能在本机 Docker 上起来的 compose，并跑通 `scripts/verify-deploy.ts`。
2. **T15** 等 T14 合并、父会话自己复现部署之后再派。父会话先把 Playwright 装进 lockfile（这是早就记下的依赖例外）。
3. **T13b** 等 T15 交回后再派。确定性用例全部跑；需要真实 DeepSeek 的用例不得超过剩余额度（已用 23 / 50），不够就停下来写进报告，不要自己加额度。

共同约束：

- 契约仍是 v1.1.1。不改 `packages/contracts`、`docs/contracts`、`docs/adr`、`docs/planning`、lockfile。
- 分支名 `task/<ID>`，worktree 在 `C:\Users\bb0\Desktop\flight-booking-wt\<ID>`。父会话已经建好 worktree 时，不要再新建。
- 不使用 `--no-verify`，不推送，不合并。
- 不打印 secret 的值。本机 `.env` 里的 `DEEPSEEK_API_KEY` 只允许写进 gitignore 的 secret 文件，然后立刻从部署目录删掉副本。compose 里禁止 `${...}` 机密插值。
- 网络、固定地址、secret × 容器矩阵以 `infra/compose/compose.yml` 文件头的 FINAL 段和 `scripts/__tests__/compose.test.ts` 为准。CT-04 / CT-05 必须继续通过。
- 阻塞写进任务文档末尾，不要改契约来绕过。
