// `pnpm new-worktree <ID>` or `pnpm new-worktree <ID>/<sub>` (D-15, A-03 §0.3, T00 item 8).
//   <ID>        → ../flight-booking-wt/<ID>          on branch task/<ID>        (from main)
//   <ID>/<sub>  → ../flight-booking-wt/<ID>--<sub>   on branch task/<ID>/<sub>  (from task/<ID>)
// Hooks: worktrees share the repository config, so core.hooksPath is inherited.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git, tryGit, repoRoot } from './lib/git.ts';
import { PARENT_BRANCH, taskIdFromBranch } from './lib/rules.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: pnpm new-worktree <ID>[/<sub>]   e.g. pnpm new-worktree T03');
  process.exit(2);
}
const branch = `task/${arg}`;
const task = taskIdFromBranch(branch);
if (!task) {
  console.error(`new-worktree: invalid ID "${arg}" (expected <ID> or <ID>/<sub>, letters/digits/-)`);
  process.exit(2);
}
// Worktrees always hang off the main checkout's parent directory, even when called from inside a worktree.
const commonDir = resolve(repoRoot(), git(['rev-parse', '--git-common-dir']).trim());
const mainRoot = dirname(commonDir);
const wtRoot = join(dirname(mainRoot), `${mainRoot.split(/[\\/]/).pop()}-wt`);
const dir = join(wtRoot, task.sub ? `${task.id}--${task.sub}` : task.id);
const base = task.sub ? `task/${task.id}` : PARENT_BRANCH;

if (existsSync(dir)) {
  console.error(`new-worktree: ${dir} already exists`);
  process.exit(1);
}
if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]) === null) {
  console.error(`new-worktree: base branch ${base} does not exist`);
  process.exit(1);
}
const exists = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;
const manifest = tryGit(['cat-file', '-e', `${PARENT_BRANCH}:docs/tasks/${task.id}.manifest`]) !== null;

git(exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base], mainRoot);
console.log(`new-worktree: ${dir}`);
console.log(`  branch: ${branch}${exists ? ' (existing)' : ` (new, from ${base})`}`);
if (!manifest)
  console.warn(
    `  WARNING: ${PARENT_BRANCH} has no docs/tasks/${task.id}.manifest — commits on ${branch} will be rejected until the parent session adds it`,
  );
const hooks = tryGit(['config', '--get', 'core.hooksPath'], mainRoot)?.trim();
if (hooks !== '.githooks')
  console.warn(
    '  WARNING: core.hooksPath is not .githooks — guardrail hooks are NOT active (git config core.hooksPath .githooks)',
  );
console.log('  next: cd into it and run `pnpm install --frozen-lockfile --offline`');
