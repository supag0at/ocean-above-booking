// pre-commit (T00 item 6): secrets (staged) → hash (working tree and staged blob) → manifest (staged).
// Invoked by .githooks/pre-commit; enable with `git config core.hooksPath .githooks`.
import { createHash } from 'node:crypto';
import { repoRoot, currentBranch, tryGit, gitBuffer } from '../lib/git.ts';
import { scan } from '../secrets.ts';
import { checkHash, LOCATIONS_DB_SHA256 } from '../hash.ts';
import { collectChanges, runManifestCheck } from '../manifest.ts';
import { PARENT_BRANCH } from '../lib/rules.ts';

const root = repoRoot();
let ok = true;

// 1. secrets in staged content
const findings = scan(root, 'staged');
if (findings.length > 0) {
  ok = false;
  console.error(`pre-commit: secrets: ${findings.length} potential secret(s) in staged content (values not printed):`);
  for (const f of findings) console.error(`  ${f.file}${f.line ? ':' + f.line : ''}  [${f.rule}]`);
} else console.log('pre-commit: secrets ok');

// 2. locations.db hash — working tree, plus the staged blob when it is in the index
const h = checkHash(root);
if (!h.ok) {
  ok = false;
  console.error(`pre-commit: ${h.message}`);
}
if (tryGit(['ls-files', '--error-unmatch', 'locations.db'], root) !== null) {
  const staged = createHash('sha256')
    .update(gitBuffer(['show', ':locations.db'], root))
    .digest('hex');
  if (staged !== LOCATIONS_DB_SHA256) {
    ok = false;
    console.error(`pre-commit: hash: staged locations.db sha256 mismatch (${staged})`);
  }
}
if (ok) console.log('pre-commit: hash ok');

// 3. protected paths + R-U1 + whitelist
const branch = currentBranch(root);
const m = runManifestCheck(
  root,
  branch,
  branch === PARENT_BRANCH || branch === null
    ? { files: [], rootPkgBefore: null, rootPkgAfter: null }
    : collectChanges(root, 'staged'),
);
for (const l of m.lines) (m.ok ? console.log : console.error)(`pre-commit: ${l}`);
if (!m.ok) ok = false;

if (!ok) {
  console.error(
    'pre-commit: commit REJECTED by guardrails (T00). Fix the issues above; do not bypass with --no-verify.',
  );
  process.exit(1);
}
