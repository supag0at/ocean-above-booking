// `node scripts/supply.ts`: H-09 supply-chain checks (A-01 §13 assigns these to T00's `pnpm check`).
//   - pnpm-workspace.yaml: ignoreScripts: true, minimumReleaseAge >= 2880 (2 days; S-16: pnpm 12 reads them only here)
//   - .npmrc: ignore-scripts=true, save-exact=true (for plain npm)
//   - every workspace package.json: dependency specifiers are exact versions or workspace:*
//   - pnpm-lock.yaml: every importer specifier is exact or workspace:*
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, repoRoot, zList } from './lib/git.ts';

const EXACT = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|workspace:\*|link:.+)$/;
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
export const MIN_RELEASE_AGE_MINUTES = 2880;

export function checkSupply(root: string): string[] {
  const errors: string[] = [];
  const ws = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(ws)) errors.push('pnpm-workspace.yaml missing');
  else {
    const y = readFileSync(ws, 'utf8');
    if (!/^ignoreScripts:\s*true\s*$/m.test(y)) errors.push('pnpm-workspace.yaml: ignoreScripts: true missing');
    const age = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(y);
    if (!age || Number(age[1]) < MIN_RELEASE_AGE_MINUTES)
      errors.push(`pnpm-workspace.yaml: minimumReleaseAge >= ${MIN_RELEASE_AGE_MINUTES} missing`);
  }
  const npmrc = join(root, '.npmrc');
  if (!existsSync(npmrc)) errors.push('.npmrc missing');
  else {
    const n = readFileSync(npmrc, 'utf8');
    if (!/^ignore-scripts\s*=\s*true\s*$/m.test(n)) errors.push('.npmrc: ignore-scripts=true missing');
    if (!/^save-exact\s*=\s*true\s*$/m.test(n)) errors.push('.npmrc: save-exact=true missing');
  }
  const pkgs = zList(
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'package.json', '*/package.json'], root),
  ).filter((f) => !f.startsWith('spikes/') && !f.includes('node_modules/') && existsSync(join(root, f)));
  for (const f of pkgs) {
    const pkg = JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const k of DEP_KEYS) {
      for (const [name, spec] of Object.entries(pkg[k] ?? {})) {
        if (!EXACT.test(spec)) errors.push(`${f}: ${k}.${name} = "${spec}" is not an exact version`);
      }
    }
  }
  const lock = join(root, 'pnpm-lock.yaml');
  if (!existsSync(lock)) errors.push('pnpm-lock.yaml missing');
  else {
    const lines = readFileSync(lock, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = /^\s+specifier:\s*'?([^'\s]+)'?\s*$/.exec(l);
      if (m && !EXACT.test(m[1] as string)) errors.push(`pnpm-lock.yaml:${i + 1}: specifier "${m[1]}" is not exact`);
    });
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = checkSupply(repoRoot());
  if (errors.length === 0) console.log('supply: ok (H-09)');
  else for (const e of errors) console.error(`supply: ${e}`);
  process.exit(errors.length === 0 ? 0 : 1);
}
