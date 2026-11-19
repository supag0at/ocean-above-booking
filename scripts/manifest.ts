// `pnpm manifest`: per-task path guardrails (D-15, R-U1, T00 items 5–6).
//
//   1. protected paths   — only branch `main` may change PROTECTED_PATHS / root package.json dependency sections
//   2. R-U1              — a manifest may not contain both frontend and backend paths (A-01 §1.3)
//   3. whitelist         — every changed file must match docs/tasks/<ID>.manifest
//
// Modes:
//   (default)          changes of the current branch vs. merge-base with main, incl. uncommitted + untracked files
//   --staged           staged changes only (pre-commit)
//   --branch <name>    committed changes of <name> vs. merge-base with main. Run this from the main checkout
//                      before merging a task branch, so the gate uses main's (unmodified) guardrail code.
//
// Manifest format (docs/tasks/<ID>.manifest): one glob per line, '#' comments, '!glob' excludes.
// The manifest is always read from `main` (falls back to the working tree only when main has no such file),
// so a task branch cannot widen its own whitelist.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, tryGit, repoRoot, zList, currentBranch } from './lib/git.ts';
import { matches, canMatchUnder } from './lib/glob.ts';
import {
  BACKEND_DIRS,
  FRONTEND_DIRS,
  PARENT_BRANCH,
  PROTECTED_PATHS,
  ROOT_PACKAGE_JSON_PROTECTED_KEYS,
  taskIdFromBranch,
} from './lib/rules.ts';

export interface Manifest {
  include: string[];
  exclude: string[];
}

export function parseManifest(text: string): Manifest {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('!')) exclude.push(line.slice(1).trim());
    else include.push(line);
  }
  return { include, exclude };
}

export function inManifest(path: string, m: Manifest): boolean {
  return m.include.some((p) => matches(path, p)) && !m.exclude.some((p) => matches(path, p));
}

/** R-U1: which sides (frontend/backend) can the manifest's include patterns reach? */
export function manifestSides(m: Manifest): { frontend: string[]; backend: string[] } {
  const frontend = m.include.filter((p) => FRONTEND_DIRS.some((d) => canMatchUnder(p, d)));
  const backend = m.include.filter((p) => BACKEND_DIRS.some((d) => canMatchUnder(p, d)));
  return { frontend, backend };
}

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((p) => matches(path, p));
}

function pickKeys(json: string | null): string {
  if (json === null) return '{}';
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return '<<unparseable>>' + json;
  }
  const out: Record<string, unknown> = {};
  for (const k of ROOT_PACKAGE_JSON_PROTECTED_KEYS) if (k in obj) out[k] = obj[k];
  return JSON.stringify(out);
}

export interface ChangeSet {
  files: string[];
  /** root package.json before / after (null = absent) */
  rootPkgBefore: string | null;
  rootPkgAfter: string | null;
}

function mergeBase(root: string, rev: string): string | null {
  const out = tryGit(['merge-base', PARENT_BRANCH, rev], root);
  return out ? out.trim() : null;
}

function showOrNull(root: string, spec: string): string | null {
  return tryGit(['show', spec], root);
}

export function collectChanges(root: string, mode: 'staged' | 'tree' | 'branch', branch?: string): ChangeSet {
  if (mode === 'staged') {
    const files = zList(git(['diff', '--cached', '--name-only', '-z', '--no-renames'], root));
    const hasHead = tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root) !== null;
    return {
      files,
      rootPkgBefore: hasHead ? showOrNull(root, 'HEAD:package.json') : null,
      rootPkgAfter: showOrNull(root, ':package.json'),
    };
  }
  const rev = mode === 'branch' ? (branch as string) : 'HEAD';
  const base = mergeBase(root, rev);
  if (!base) throw new Error(`manifest: cannot find merge-base of ${PARENT_BRANCH} and ${rev}`);
  if (mode === 'branch') {
    const files = zList(git(['diff', '--name-only', '-z', '--no-renames', base, rev], root));
    return {
      files,
      rootPkgBefore: showOrNull(root, `${base}:package.json`),
      rootPkgAfter: showOrNull(root, `${rev}:package.json`),
    };
  }
  const tracked = zList(git(['diff', '--name-only', '-z', '--no-renames', base], root));
  const untracked = zList(git(['ls-files', '-z', '--others', '--exclude-standard'], root));
  const files = [...new Set([...tracked, ...untracked])];
  const after = existsSync(join(root, 'package.json')) ? readFileSync(join(root, 'package.json'), 'utf8') : null;
  return { files, rootPkgBefore: showOrNull(root, `${base}:package.json`), rootPkgAfter: after };
}

export function loadManifest(root: string, id: string): { manifest: Manifest; source: string } | null {
  const rel = `docs/tasks/${id}.manifest`;
  const fromMain = tryGit(['show', `${PARENT_BRANCH}:${rel}`], root);
  if (fromMain !== null) return { manifest: parseManifest(fromMain), source: `${PARENT_BRANCH}:${rel}` };
  const abs = join(root, rel);
  if (existsSync(abs))
    return {
      manifest: parseManifest(readFileSync(abs, 'utf8')),
      source: `${rel} (working tree; not on ${PARENT_BRANCH} yet)`,
    };
  return null;
}

export interface Result {
  ok: boolean;
  lines: string[];
}

export function runManifestCheck(root: string, branch: string | null, changes: ChangeSet): Result {
  const lines: string[] = [];
  if (branch === null)
    return { ok: false, lines: ['manifest: detached HEAD — commit on main or on a task/<ID> branch'] };
  if (branch === PARENT_BRANCH)
    return { ok: true, lines: [`manifest: branch ${branch} (parent session) — protected paths allowed, no manifest`] };

  const task = taskIdFromBranch(branch);
  if (!task) {
    return {
      ok: false,
      lines: [
        `manifest: branch "${branch}" is neither ${PARENT_BRANCH} nor task/<ID>[/<sub>] — cannot determine the task (D-15)`,
      ],
    };
  }
  let ok = true;

  // 1. protected paths
  const prot = changes.files.filter(isProtectedPath);
  const pkgDepsChanged =
    changes.files.includes('package.json') && pickKeys(changes.rootPkgBefore) !== pickKeys(changes.rootPkgAfter);
  if (prot.length > 0 || pkgDepsChanged) {
    ok = false;
    lines.push(`manifest: PROTECTED paths changed on ${branch} (only ${PARENT_BRANCH} may change them):`);
    for (const f of prot) lines.push(`  ${f}`);
    if (pkgDepsChanged)
      lines.push(`  package.json (dependency sections: ${ROOT_PACKAGE_JSON_PROTECTED_KEYS.join(', ')})`);
  } else {
    lines.push('manifest: protected paths ok');
  }

  // 2 + 3 need the manifest
  const loaded = loadManifest(root, task.id);
  if (!loaded) {
    lines.push(`manifest: docs/tasks/${task.id}.manifest not found — every task branch needs a manifest`);
    return { ok: false, lines };
  }
  const { manifest, source } = loaded;

  const sides = manifestSides(manifest);
  if (sides.frontend.length > 0 && sides.backend.length > 0) {
    ok = false;
    lines.push(`manifest: R-U1 violation in ${source}: frontend and backend paths in one manifest`);
    lines.push(`  frontend: ${sides.frontend.join(', ')}`);
    lines.push(`  backend:  ${sides.backend.join(', ')}`);
  } else {
    lines.push(`manifest: R-U1 ok (${source})`);
  }

  const outside = changes.files.filter((f) => !inManifest(f, manifest));
  if (outside.length > 0) {
    ok = false;
    lines.push(`manifest: ${outside.length} file(s) outside the whitelist of ${source}:`);
    for (const f of outside) lines.push(`  ${f}`);
  } else {
    lines.push(`manifest: whitelist ok (${changes.files.length} changed file(s))`);
  }
  return { ok, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = repoRoot();
  const args = process.argv.slice(2);
  let mode: 'staged' | 'tree' | 'branch' = 'tree';
  let branch: string | null = currentBranch(root);
  if (args.includes('--staged')) mode = 'staged';
  const bi = args.indexOf('--branch');
  if (bi !== -1) {
    mode = 'branch';
    branch = args[bi + 1] ?? null;
    if (!branch) {
      console.error('manifest: --branch needs a branch name');
      process.exit(2);
    }
  }
  let r: Result;
  try {
    r = runManifestCheck(
      root,
      branch,
      branch === PARENT_BRANCH || branch === null
        ? { files: [], rootPkgBefore: null, rootPkgAfter: null }
        : collectChanges(root, mode, branch),
    );
  } catch (e) {
    r = { ok: false, lines: [(e as Error).message] };
  }
  for (const l of r.lines) (r.ok ? console.log : console.error)(l);
  process.exit(r.ok ? 0 : 1);
}
