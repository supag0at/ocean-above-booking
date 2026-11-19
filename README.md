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
