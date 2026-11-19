// `pnpm check` (T00 item 5): typecheck → lint → depcruise → test → hash → secrets → manifest,
// plus the two A-01 checks assigned to T00 (§13 H-09 supply chain, §1.2 tickets INSERT grep).
// `node scripts/check.ts <step> [<step>...]` runs only the named steps.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from './lib/git.ts';

const root = repoRoot();

function bin(pkg: string, name: string = pkg): string {
  // read package.json straight from node_modules: some packages do not export ./package.json
  const pj = join(root, 'node_modules', pkg, 'package.json');
  const meta = JSON.parse(readFileSync(pj, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[name];
  if (!rel) throw new Error(`no bin ${name} in ${pkg}`);
  return join(dirname(pj), rel);
}

function node(script: string, args: string[]): boolean {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  return r.status === 0;
}

function workspaceProjects(): string[] {
  const out: string[] = ['tsconfig.json'];
  for (const group of ['apps', 'services', 'packages']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    const r = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', `${group}/*/tsconfig.json`],
      { cwd: root, encoding: 'utf8' },
    );
    for (const f of r.stdout.split(/\r?\n/).filter(Boolean)) out.push(f);
  }
  return out;
}

const steps: Record<string, () => boolean> = {
  typecheck: () =>
    workspaceProjects().every((p) => {
      console.log(`  tsc -p ${p}`);
      return node(bin('typescript', 'tsc'), ['-p', p, '--noEmit']);
    }),
  lint: () =>
    node(bin('eslint'), ['--max-warnings=0', '.']) && node(bin('prettier'), ['--check', '--log-level=warn', '.']),
  depcruise: () =>
    node(bin('dependency-cruiser', 'depcruise'), [
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'err',
      'apps',
      'services',
      'packages',
    ]),
  test: () => node(bin('vitest'), ['run']),
  hash: () => node(join(root, 'scripts/hash.ts'), []),
  secrets: () => node(join(root, 'scripts/secrets.ts'), []),
  manifest: () => node(join(root, 'scripts/manifest.ts'), []),
  supply: () => node(join(root, 'scripts/supply.ts'), []),
  'tickets-insert': () => node(join(root, 'scripts/tickets-insert.ts'), []),
};

const requested = process.argv.slice(2);
const order = requested.length > 0 ? requested : Object.keys(steps);
const failed: string[] = [];
for (const name of order) {
  const step = steps[name];
  if (!step) {
    console.error(`check: unknown step "${name}" (known: ${Object.keys(steps).join(', ')})`);
    process.exit(2);
  }
  console.log(`\n▶ ${name}`);
  const ok = step();
  console.log(ok ? `✔ ${name}` : `✖ ${name}`);
  if (!ok) failed.push(name);
}
console.log(
  failed.length === 0 ? `\ncheck: all ${order.length} step(s) passed` : `\ncheck: FAILED: ${failed.join(', ')}`,
);
process.exit(failed.length === 0 ? 0 : 1);
