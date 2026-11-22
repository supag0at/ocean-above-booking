# Ocean Above

自然语言订机票。城市、航线和价格只来自 `locations.db`。报价由确定性代码计算，用户在报价卡上点击确认之后才会出票。

线上演示：https://g0at.top

打开后只填用户名即可登录。这台运行 Docker 的电脑休眠或关机后，这个地址不可用。

## 设计文档

| 文档 | 内容 |
|---|---|
| [docs/final/01-前后端.md](docs/final/01-前后端.md) | 架构与数据流、航线距离和价格、确认出票、局限 |
| [docs/final/02-agent与评测.md](docs/final/02-agent与评测.md) | 工具及理由、数字如何显示、确认机制、评测结果、局限 |

过程设计、契约和决策在 `docs/design/`、`docs/contracts/`、`docs/adr/`。评测原始结果在 `eval/reports/`。

对话记录另打包交付，不在这个仓库里。

## 本地运行

需要 Node 24、pnpm 12、Docker Compose v2。

```sh
pnpm install --frozen-lockfile
git config core.hooksPath .githooks
```

密钥放在 `infra/secrets/`（已被 gitignore）。模板是 `infra/secrets/*.example`。DeepSeek 的 key 从本机 `.env` 写进 `infra/secrets/deepseek_api_key`，不要把 `.env` 提交，也不要在 compose 里用 `${...}` 插入密钥。

Windows：

```powershell
powershell -File infra/vm/init.ps1 -EnvFile C:\path\to\.env
```

Linux / Git Bash：

```sh
bash infra/vm/init.sh /path/to/.env
```

当前仓库里的 `infra/compose/site.env` 面向线上：`PUBLIC_ORIGIN=https://g0at.top`，`COOKIE_SECURE=1`。只在本机用 HTTP 时，把这两项改成 `http://127.0.0.1` 和 `0`，登录请求的 `Origin` 也要一致。

```sh
docker compose -f infra/compose/compose.yml --env-file infra/compose/site.env up --build -d
node scripts/verify-deploy.ts
```

浏览器打开 `site.env` 里的 `PUBLIC_ORIGIN`。登录是 `POST /api/v1/auth/login`，body 只有 `username`。

公网隧道是另一份 compose，不改被测试固定的八个服务。授权并放好 `infra/cloudflared/config.yml` 和 `infra/secrets/cloudflare_tunnel_credentials.json` 之后：

```sh
docker compose -f infra/compose/compose.yml -f infra/compose/compose.tunnel.yml --env-file infra/compose/site.env up -d
```

现在的 https://g0at.top 由宿主机上的 cloudflared 转到本机 80 端口，不是由上面这个容器提供的。

## 检查

```sh
pnpm check
node --experimental-strip-types --disable-warning=ExperimentalWarning eval/runner/cli.ts deterministic
```

`pnpm check` 包含类型、lint、依赖边界、测试、`locations.db` 哈希和密钥扫描。确定性评测不调用模型。带模型的 agent 评测会花钱，结果和未跑条目写在 `eval/reports/T13b.md`。

## 开发约定

任务在独立 worktree 里做，分支名 `task/<ID>`。该分支只能改 `docs/tasks/<ID>.manifest` 列出的路径，前后端不能由同一次任务一起改。

```sh
pnpm new-worktree T03
node scripts/manifest.ts --branch task/T03
```

依赖只在主分支上加。`locations.db`、契约、lockfile 和 `infra/secrets/` 里的真实密钥都不能由任务分支改动。
