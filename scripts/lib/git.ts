// Small git helpers for the guardrail scripts. Scripts are not product code, so child_process is allowed here
// (the A-01 §1.2 ban applies to apps/*, services/*, packages/*).
import { execFileSync } from 'node:child_process';

export function git(args: string[], cwd: string = process.cwd()): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function gitBuffer(args: string[], cwd: string = process.cwd()): Buffer {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

export function tryGit(args: string[], cwd: string = process.cwd()): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string = process.cwd()): string {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

/** NUL-separated output → list (use with `-z`). */
export function zList(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** Current branch name, or null on detached HEAD. */
export function currentBranch(cwd: string = process.cwd()): string | null {
  const out = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  return out ? out.trim() : null;
}
