// T00 guardrail tests. Every case first asserts that the scenario's preconditions hold (hooks active,
// right branch, file staged, rule applicable, a control commit passes), then asserts the guardrail blocks it.
import { randomBytes } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedRepo, REAL_ROOT, run, TempRepo } from './fixture.ts';
import { isProtectedPath, inManifest, parseManifest, manifestSides } from '../manifest.ts';
import { scanText } from '../secrets.ts';
import { checkHash } from '../hash.ts';

const cleanup: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.cleanup();
});

function setup(manifests: Record<string, string[]>, branch: string): TempRepo {
  const repo = guardedRepo(manifests);
  cleanup.push(repo);
  repo.mustGit('switch', '-q', '-c', branch);
  // precondition common to every hook test: hooks are active and we are on the task branch
  expect(repo.mustGit('config', '--get', 'core.hooksPath').trim()).toBe('.githooks');
  expect(repo.mustGit('symbolic-ref', '--short', 'HEAD').trim()).toBe(branch);
  return repo;
}

function expectRejected(repo: TempRepo, headBefore: string, r: ReturnType<TempRepo['commit']>, marker: RegExp): void {
  expect(r.status, r.out).not.toBe(0);
  expect(r.out).toMatch(/commit REJECTED by guardrails/);
  expect(r.out).toMatch(marker);
  expect(repo.head()).toBe(headBefore); // nothing was committed
}

describe('guardrail 1: changing a protected path on a task branch is rejected', () => {
  it('rejects packages/contracts/** even when the manifest lists it', () => {
    const manifest = ['packages/contracts/**', 'docs/notes/**'];
    const repo = setup({ T90: manifest }, 'task/T90');
    const target = 'packages/contracts/src/web/index.ts';

    // preconditions: target is protected, it IS whitelisted (so only the protected rule can reject),
    // and a control commit of a non-protected whitelisted file passes.
    expect(isProtectedPath(target)).toBe(true);
    expect(inManifest(target, parseManifest(manifest.join('\n')))).toBe(true);
    repo.write('docs/notes/a.md', 'control\n');
    const control = repo.commit('control', 'docs/notes/a.md');
    expect(control.status, control.out).toBe(0);

    const before = repo.head();
    repo.write(target, 'export const X = 1;\n');
    expectRejected(
      repo,
      before,
      repo.commit('touch contracts', target),
      /PROTECTED paths changed[\s\S]*packages\/contracts\/src\/web\/index\.ts/,
    );
  });

  it('rejects a change to the root package.json dependency sections but allows other root package.json edits', () => {
    const repo = setup({ T90: ['package.json'] }, 'task/T90');
    const pkg = JSON.parse(readFileSync(join(repo.dir, 'package.json'), 'utf8')) as Record<string, unknown>;

    // precondition: package.json itself is not a protected path; a non-dependency edit passes.
    expect(isProtectedPath('package.json')).toBe(false);
    repo.write('package.json', JSON.stringify({ ...pkg, description: 'non-dependency edit' }, null, 2) + '\n');
    const control = repo.commit('edit description', 'package.json');
    expect(control.status, control.out).toBe(0);

    const before = repo.head();
    const withDep = { ...pkg, description: 'non-dependency edit', dependencies: { 'left-pad': '1.3.0' } };
    repo.write('package.json', JSON.stringify(withDep, null, 2) + '\n');
    expectRejected(repo, before, repo.commit('add dependency', 'package.json'), /package\.json \(dependency sections/);
  });

  it('rejects a commit on a branch that is neither main nor task/<ID>', () => {
    const repo = setup({}, 'feature/x');
    repo.write('docs/notes/a.md', 'x\n');
    const before = repo.head();
    expectRejected(repo, before, repo.commit('x', 'docs/notes/a.md'), /neither main nor task\/<ID>/);
  });
});

describe('guardrail 2: committing a file outside the manifest is rejected', () => {
  it('rejects services/booking/** on a branch whose manifest only lists services/gateway/**', () => {
    const manifest = ['services/gateway/**'];
    const repo = setup({ T91: manifest }, 'task/T91');
    const outside = 'services/booking/src/index.ts';
    const m = parseManifest(manifest.join('\n'));

    // preconditions: not protected, not whitelisted; a whitelisted control commit passes.
    expect(isProtectedPath(outside)).toBe(false);
    expect(inManifest(outside, m)).toBe(false);
    expect(inManifest('services/gateway/src/a.ts', m)).toBe(true);
    repo.write('services/gateway/src/a.ts', 'export const a = 1;\n');
    const control = repo.commit('control', 'services/gateway/src/a.ts');
    expect(control.status, control.out).toBe(0);

    const before = repo.head();
    repo.write(outside, 'export const b = 1;\n');
    expectRejected(
      repo,
      before,
      repo.commit('outside', outside),
      /outside the whitelist[\s\S]*services\/booking\/src\/index\.ts/,
    );
  });

  it('task/<ID>/<sub> branches use the <ID> manifest; a missing manifest is rejected', () => {
    const repo = setup({ T91: ['services/gateway/**'] }, 'task/T91/routes');
    repo.write('services/gateway/src/r.ts', 'export {};\n');
    const ok = repo.commit('sub-branch inside whitelist', 'services/gateway/src/r.ts');
    expect(ok.status, ok.out).toBe(0);

    repo.mustGit('switch', '-q', '-c', 'task/T99', 'main');
    const before = repo.head();
    repo.write('services/gateway/src/s.ts', 'export {};\n');
    expectRejected(repo, before, repo.commit('no manifest', 'services/gateway/src/s.ts'), /T99\.manifest not found/);
  });
});

describe('guardrail 3: frontend and backend paths together are rejected (R-U1)', () => {
  it('rejects a commit touching apps/web and services/gateway under a mixed manifest', () => {
    const mixed = ['apps/web/**', 'services/gateway/**'];
    const frontOnly = ['apps/web/**'];
    const repo = setup({ T92: mixed, T93: frontOnly }, 'task/T93');
    const fe = 'apps/web/src/a.ts';
    const be = 'services/gateway/src/b.ts';

    // preconditions: both files are whitelisted by the mixed manifest and neither is protected;
    // the classifier sees both sides in the mixed manifest and only one in the control manifest;
    // the frontend file alone commits fine under the front-only manifest (control).
    const mm = parseManifest(mixed.join('\n'));
    expect(inManifest(fe, mm) && inManifest(be, mm)).toBe(true);
    expect(isProtectedPath(fe) || isProtectedPath(be)).toBe(false);
    expect(manifestSides(mm).frontend.length).toBeGreaterThan(0);
    expect(manifestSides(mm).backend.length).toBeGreaterThan(0);
    expect(manifestSides(parseManifest(frontOnly.join('\n'))).backend).toEqual([]);
    repo.write(fe, 'export const fe = 1;\n');
    const control = repo.commit('front only', fe);
    expect(control.status, control.out).toBe(0);

    repo.mustGit('switch', '-q', '-c', 'task/T92', 'main');
    const before = repo.head();
    repo.write(fe, 'export const fe = 2;\n');
    repo.write(be, 'export const be = 2;\n');
    expectRejected(
      repo,
      before,
      repo.commit('front + back', fe, be),
      /R-U1 violation[\s\S]*frontend: apps\/web\/\*\*[\s\S]*backend: {2}services\/gateway\/\*\*/,
    );
  });

  it('also catches wildcard manifests that reach both sides (e.g. apps/*/src/** + services/*/src/**)', () => {
    const sides = manifestSides(parseManifest(['apps/*/src/**', 'packages/*/package.json'].join('\n')));
    expect(sides.frontend).toEqual(['apps/*/src/**']);
    expect(sides.backend).toEqual(['packages/*/package.json']);
    expect(manifestSides(parseManifest('**')).frontend).toEqual(['**']);
    expect(manifestSides(parseManifest('**')).backend).toEqual(['**']);
  });
});

describe('guardrail 4: committing something that looks like a secret is rejected', () => {
  // built at runtime so that this test file does not contain a key-shaped literal
  const fakeDeepseekKey = 'sk-' + randomBytes(16).toString('hex');
  const fakePem =
    ['-----', 'BEGIN PRIVATE KEY', '-----'].join('') +
    '\nMC4CAQAwBQYDK2VwBCIEIA==\n' +
    ['-----', 'END PRIVATE KEY', '-----'].join('');

  it('rejects a DeepSeek-format key and never prints it', () => {
    const repo = setup({ T94: ['services/gateway/**'] }, 'task/T94');
    const file = 'services/gateway/src/config.ts';

    // preconditions: the scanner recognises the value; the file is whitelisted; the same file without
    // the value commits fine (control).
    expect(scanText(file, `const k = '${fakeDeepseekKey}';`).map((f) => f.rule)).toContain('deepseek-api-key');
    expect(inManifest(file, parseManifest('services/gateway/**'))).toBe(true);
    repo.write(file, "const k = process.env.NOTHING ?? '';\nexport { k };\n");
    const control = repo.commit('control', file);
    expect(control.status, control.out).toBe(0);

    const before = repo.head();
    repo.write(file, `const k = '${fakeDeepseekKey}';\nexport { k };\n`);
    const r = repo.commit('leak', file);
    expectRejected(
      repo,
      before,
      r,
      /secrets: \d+ potential secret[\s\S]*services\/gateway\/src\/config\.ts:1 {2}\[deepseek-api-key\]/,
    );
    expect(r.out).not.toContain(fakeDeepseekKey);
  });

  it('rejects a PEM private key block and a force-added .env file', () => {
    const repo = setup({ T94: ['services/gateway/**', '.env'] }, 'task/T94');
    expect(scanText('k.pem', fakePem).map((f) => f.rule)).toContain('private-key-block');

    let before = repo.head();
    repo.write('services/gateway/src/key.pem', fakePem + '\n');
    expectRejected(repo, before, repo.commit('pem', 'services/gateway/src/key.pem'), /\[private-key-block\]/);
    repo.mustGit('reset', '-q', 'HEAD', '--', 'services/gateway/src/key.pem');

    before = repo.head();
    repo.write('.gitignore', '.env\n');
    repo.write('.env', 'X=1\n');
    expect(repo.git('check-ignore', '-q', '.env').status).toBe(0); // precondition: .env is ignored, so it needs -f
    repo.mustGit('add', '-f', '.env');
    const r = repo.git('commit', '-m', 'env');
    expectRejected(repo, before, r, /\.env {2}\[forbidden-secret-file\]/);
  });
});

describe('guardrail 5: one changed byte in locations.db makes `hash` fail', () => {
  it('fails after flipping a single byte', () => {
    const repo = new TempRepo('fb-hash-');
    cleanup.push(repo);
    cpSync(join(REAL_ROOT, 'scripts'), join(repo.dir, 'scripts'), {
      recursive: true,
      filter: (s) => !s.includes('__tests__'),
    });
    cpSync(join(REAL_ROOT, 'locations.db'), join(repo.dir, 'locations.db'));
    repo.mustGit('init', '-q', '-b', 'main');

    // precondition: the pristine copy passes, via the library and via the CLI
    expect(checkHash(repo.dir).ok).toBe(true);
    const pristine = run(process.execPath, ['scripts/hash.ts'], repo.dir);
    expect(pristine.status, pristine.out).toBe(0);

    const file = join(repo.dir, 'locations.db');
    const buf = readFileSync(file);
    const offset = Math.floor(buf.length / 2);
    buf[offset] = (buf[offset] as number) ^ 0x01;
    writeFileSync(file, buf);
    expect(readFileSync(file).length).toBe(readFileSync(join(REAL_ROOT, 'locations.db')).length); // exactly one byte differs

    expect(checkHash(repo.dir).ok).toBe(false);
    const r = run(process.execPath, ['scripts/hash.ts'], repo.dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/sha256 mismatch/);
  });
});

describe('guardrail 6: dependency-cruiser rejects "harness imports pg"', () => {
  const depcruise = join(REAL_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
  const config = join(REAL_ROOT, '.dependency-cruiser.cjs');

  function cruise(dir: string): {
    status: number | null;
    violations: Array<{ rule: { name: string }; from: string; to: string }>;
  } {
    // json reporter: which rules fired; err reporter: the exit code `pnpm check` relies on
    const r = run(process.execPath, [depcruise, '--config', config, '--output-type', 'json', 'services'], dir);
    const json = JSON.parse(r.stdout) as {
      summary: { violations: Array<{ rule: { name: string }; from: string; to: string }> };
    };
    const gate = run(process.execPath, [depcruise, '--config', config, '--output-type', 'err', 'services'], dir);
    return { status: gate.status, violations: json.summary.violations };
  }

  it('reports harness-forbidden for services/harness → pg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-depcruise-'));
    cleanup.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
    mkdirSync(join(dir, 'services/harness/src'), { recursive: true });

    // precondition (control): an allowed import (bullmq is on harness's allow-list) yields no violations
    writeFileSync(join(dir, 'services/harness/src/index.ts'), "import { Queue } from 'bullmq';\nexport { Queue };\n");
    expect(existsSync(depcruise)).toBe(true);
    const clean = cruise(dir);
    expect(clean.violations).toEqual([]);
    expect(clean.status).toBe(0);

    // scenario: harness imports pg
    writeFileSync(join(dir, 'services/harness/src/index.ts'), "import pg from 'pg';\nexport default pg;\n");
    expect(readFileSync(join(dir, 'services/harness/src/index.ts'), 'utf8')).toContain("from 'pg'");
    const bad = cruise(dir);
    expect(bad.status).not.toBe(0);
    const names = bad.violations
      .filter((v) => v.from === 'services/harness/src/index.ts' && v.to === 'pg')
      .map((v) => v.rule.name);
    expect(names).toContain('harness-forbidden');
    expect(names).toContain('harness-reach-pg');
  });
});
