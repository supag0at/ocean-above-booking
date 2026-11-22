# Ocean Above — flight booking (monorepo)

Development environment only. Design, contracts and decisions live in `docs/`.

## Requirements

- Node 24 LTS (D-21; `.node-version`). Node ≥ 22.18 can run the tooling, but production images use Node 24.
- pnpm 12 (`packageManager` in `package.json`)
- git, Docker with Compose v2

## First setup

```sh
pnpm install --frozen-lockfile        # install scripts are disabled (ignoreScripts, H-09)
git config core.hooksPath .githooks   # enable the guardrail hooks (once per clone; worktrees inherit it)
pnpm check                            # typecheck, lint, depcruise, test, hash, secrets, manifest, supply, tickets-insert
```

Supply-chain settings (`ignoreScripts`, `minimumReleaseAge`, exact versions) are in `pnpm-workspace.yaml`;
pnpm 12 does not read them from `.npmrc` (S-16). Dependencies are added only by the parent session.

## Working on a task

```sh
pnpm new-worktree T03        # ../flight-booking-wt/T03 on branch task/T03 (from main)
pnpm new-worktree T03/routes # ../flight-booking-wt/T03--routes on task/T03/routes (from task/T03)
```

Each task branch `task/<ID>[/<sub>]` may only change the paths in `docs/tasks/<ID>.manifest` (read from `main`).
The pre-commit hook rejects:

- changes to protected paths on any branch other than `main` (contracts, ADRs, planning, lockfile, root
  dependency sections, `.npmrc`, `pnpm-workspace.yaml`, `locations.db`, task manifests);
- files outside the manifest, and manifests that mix frontend (`apps/web`) and backend paths (R-U1);
- anything that looks like a secret, and any `.env` / `infra/secrets/*` file;
- a modified `locations.db`.

Before merging a task branch, run the gate from the `main` checkout, so main's guardrail code is used:

```sh
node scripts/manifest.ts --branch task/T03
```

## Local secrets

Real secret files go in `infra/secrets/<name>` (gitignored); templates are `infra/secrets/*.example`.
Compose mounts them as file-based secrets (D-28); they are never environment variables.

```sh
docker compose -f infra/compose/compose.yml config
```

## 部署

公网域名是 `https://g0at.top`。非机密站点配置在 `infra/compose/site.env`：`SITE_ADDRESS=:80`（源站仍是 HTTP）、`PUBLIC_ORIGIN=https://g0at.top`、`COOKIE_SECURE=1`。浏览器看到的是 Cloudflare 的证书。隧道配置在 `infra/compose/compose.tunnel.yml`，不改那份被测试冻结的八容器 compose。

机密只放在 gitignore 的 `infra/secrets/`。根目录 `.env` 里的 DeepSeek key 只写入 `deepseek_api_key`，不要把 `.env` 拷进部署目录，也不要在 compose 里用 `${...}` 插值任何机密。

Windows 上生成机密（不打印内容）：

```powershell
powershell -File infra/vm/init.ps1 -EnvFile C:\path\to\.env
```

Linux / Git Bash：

```sh
bash infra/vm/init.sh /path/to/.env
```

启动（项目名是 compose 文件里的 `ocean-above`，宿主机端口保持 80 和 443）：

```sh
docker compose -f infra/compose/compose.yml --env-file infra/compose/site.env up --build -d
```

加上隧道（授权并生成 `infra/cloudflared/config.yml` 和 `infra/secrets/cloudflare_tunnel_credentials.json` 之后）：

```sh
docker compose -f infra/compose/compose.yml -f infra/compose/compose.tunnel.yml --env-file infra/compose/site.env up -d
```

对外地址是 `https://g0at.top/`。登录请求的 `Origin` 必须是 `https://g0at.top`。

看健康和一次性迁移是否退出 0：

```sh
docker compose -f infra/compose/compose.yml --env-file infra/compose/site.env ps
```

验收：

```sh
node scripts/verify-deploy.ts
```

浏览器打开 `http://127.0.0.1/`。登录是 `POST http://127.0.0.1/api/v1/auth/login`，`Origin: http://127.0.0.1`，body 只有用户名。不要为了验收去调用 DeepSeek。
