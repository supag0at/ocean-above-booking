// Test fixture: a throw-away git repository that carries the real guardrail code (scripts/, .githooks/)
// and the real locations.db, with core.hooksPath enabled. Nothing here touches the real repository.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  out: string;
}

export function run(cmd: string, args: string[], cwd: string): Run {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

export class TempRepo {
  readonly dir: string;
  constructor(prefix = 'fb-guardrail-') {
    this.dir = mkdtempSync(join(tmpdir(), prefix));
  }
  git(...args: string[]): Run {
    return run('git', args, this.dir);
  }
  mustGit(...args: string[]): string {
    const r = this.git(...args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.out}`);
    return r.stdout;
  }
  write(rel: string, content: string | Buffer): void {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  /** `git add` + `git commit` (hooks run). */
  commit(message: string, ...paths: string[]): Run {
    this.mustGit('add', '--', ...paths);
    return this.git('commit', '-m', message);
  }
  head(): string {
    return this.mustGit('rev-parse', 'HEAD').trim();
  }
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Repo with guardrails installed and an initial commit on main containing the given manifests
 * (docs/tasks/<ID>.manifest → lines). Returns on branch main.
 */
export function guardedRepo(manifests: Record<string, string[]>): TempRepo {
  const repo = new TempRepo();
  cpSync(join(REAL_ROOT, 'scripts'), join(repo.dir, 'scripts'), {
    recursive: true,
    filter: (src) => !src.includes('__tests__'),
  });
  cpSync(join(REAL_ROOT, '.githooks'), join(repo.dir, '.githooks'), { recursive: true });
  cpSync(join(REAL_ROOT, 'locations.db'), join(repo.dir, 'locations.db'));
  repo.write(
    'package.json',
    JSON.stringify(
      { name: 'fixture', private: true, type: 'module', devDependencies: { typescript: '6.0.3' } },
      null,
      2,
    ) + '\n',
  );
  repo.write('.gitattributes', '* -text\n');
  repo.write('packages/contracts/src/web/index.ts', 'export {};\n');
  repo.write('services/gateway/src/index.ts', 'export {};\n');
  for (const [id, lines] of Object.entries(manifests)) repo.write(`docs/tasks/${id}.manifest`, lines.join('\n') + '\n');
  repo.mustGit('init', '-q', '-b', 'main');
  repo.mustGit('config', 'user.name', 'guardrail-test');
  repo.mustGit('config', 'user.email', 'guardrail-test@example.invalid');
  repo.mustGit('config', 'core.autocrlf', 'false');
  repo.mustGit('config', 'commit.gpgsign', 'false');
  repo.mustGit('config', 'core.hooksPath', '.githooks');
  const first = repo.commit('init on main', '.');
  if (first.status !== 0) throw new Error(`initial commit on main failed (hook should allow main):\n${first.out}`);
  return repo;
}
