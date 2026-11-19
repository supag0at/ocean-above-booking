// Guardrail data: directory ownership (A-01 §1.3, R-U1) and protected paths (T00 item 6).
// Changing this file changes the guardrails for every session; it is itself guarded by the manifest whitelist.

/** A-01 §1.3 "前端会话" directories. */
export const FRONTEND_DIRS: readonly string[] = ['apps/web/'];

/** A-01 §1.3 "后端会话" directories. */
export const BACKEND_DIRS: readonly string[] = [
  'services/',
  'packages/flight-core/',
  'packages/memory/',
  'packages/platform/',
  'infra/db/',
  'infra/redis/',
];

/**
 * Paths only the parent session (branch `main`) may change (T00 item 6). Any other branch touching
 * them is rejected by pre-commit and by `pnpm check`.
 *
 * The root package.json is protected only in its dependency sections — see ROOT_PACKAGE_JSON_PROTECTED_KEYS.
 */
export const PROTECTED_PATHS: readonly string[] = [
  // T00.md item 6 (as planned)
  'packages/contracts/**',
  'docs/contracts/**',
  'docs/adr/**',
  'docs/planning/**',
  'pnpm-lock.yaml',
  '.npmrc',
  'locations.db',
  // T00 additions, flagged to the parent session for confirmation (see docs/tasks/T00.md 汇报):
  // - pnpm 12 reads ignoreScripts / minimumReleaseAge ONLY from pnpm-workspace.yaml (S-16), so this file
  //   is the effective twin of .npmrc;
  'pnpm-workspace.yaml',
  // - a task branch must not be able to widen its own whitelist.
  'docs/tasks/*.manifest',
];

/** T00 item 6: "根目录 package.json 的依赖段". */
export const ROOT_PACKAGE_JSON_PROTECTED_KEYS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions',
  'pnpm',
  'packageManager',
];

/** Branch that is allowed to change protected paths (the parent session). */
export const PARENT_BRANCH = 'main';

/** `task/<ID>` or `task/<ID>/<sub>` (D-15, A-03 §0.3). */
export const TASK_BRANCH_RE = /^task\/([A-Za-z0-9][A-Za-z0-9-]*)(?:\/([A-Za-z0-9][A-Za-z0-9._-]*))?$/;

export function taskIdFromBranch(branch: string): { id: string; sub: string | null } | null {
  const m = TASK_BRANCH_RE.exec(branch);
  if (!m) return null;
  return { id: m[1] as string, sub: m[2] ?? null };
}
