// `pnpm secrets`: scan for committed secrets (A-01 §2.3, D-28).
//   default   : every tracked file + every untracked, non-ignored file in the working tree
//   --staged  : the staged (index) content of every added/changed file — used by pre-commit
// Matched values are NEVER printed; only file, line and rule name.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, gitBuffer, repoRoot, zList } from './lib/git.ts';
import { matchesAny } from './lib/glob.ts';

interface Rule {
  name: string;
  re: RegExp;
}

// Patterns are built from pieces so that this file does not match itself.
const BEGIN = '-----' + 'BEGIN';
export const SECRET_RULES: readonly Rule[] = [
  // DeepSeek API key: "sk-" + 32 hex chars (also catches other OpenAI-style sk- keys of 20+ chars)
  { name: 'deepseek-api-key', re: new RegExp('\\bsk-[a-f0-9]{32}\\b') },
  { name: 'sk-style-api-key', re: new RegExp('\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}') },
  // PEM private keys of any kind (RSA, EC, OPENSSH, ENCRYPTED, plain PKCS#8 such as Ed25519)
  { name: 'private-key-block', re: new RegExp(BEGIN + ' (?:[A-Z0-9]+ )*PRIVATE KEY-----') },
  { name: 'aws-access-key-id', re: new RegExp('\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b') },
  { name: 'github-token', re: new RegExp('\\bgh[pousr]_[A-Za-z0-9]{36,}\\b') },
  { name: 'slack-token', re: new RegExp('\\bxox[abprs]-[A-Za-z0-9-]{10,}') },
  // KEY=value assignments in env-style files with a non-placeholder value
  {
    name: 'secret-assignment',
    re: new RegExp(
      '^\\s*(?:export\\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|TOKEN)[A-Z0-9_]*\\s*[=:]\\s*["\']?(?!changeme|change-me|example|placeholder|xxx|<|\\$\\{|\\$\\(|/run/secrets/)[A-Za-z0-9+/_-]{16,}',
    ),
  },
];

/** Files that must never be committed regardless of content. */
export const FORBIDDEN_FILES: readonly string[] = ['.env', '**/.env', '.env.*', '**/.env.*', 'infra/secrets/*'];
/** Exceptions to FORBIDDEN_FILES (templates). Their content is still scanned. */
export const FORBIDDEN_FILE_EXCEPTIONS: readonly string[] = ['**/*.example', '.env.example', 'infra/secrets/README.md'];

/** Content-scan exclusions: binary data and vendored lockfiles. */
const SKIP_CONTENT: readonly string[] = [
  'locations.db',
  '**/*.db',
  '**/*.png',
  '**/*.jpg',
  '**/*.ico',
  '**/*.woff2',
  'pnpm-lock.yaml',
  '**/package-lock.json',
];

export interface Finding {
  file: string;
  line: number;
  rule: string;
}

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const r of SECRET_RULES) if (r.re.test(l)) out.push({ file, line: i + 1, rule: r.name });
  });
  return out;
}

function isForbiddenFile(path: string): boolean {
  return matchesAny(path, FORBIDDEN_FILES) && !matchesAny(path, FORBIDDEN_FILE_EXCEPTIONS);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function scan(root: string, mode: 'tree' | 'staged'): Finding[] {
  const findings: Finding[] = [];
  let files: string[];
  if (mode === 'staged') {
    files = zList(git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMRTUXB'], root));
  } else {
    files = zList(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root));
  }
  for (const f of files) {
    if (isForbiddenFile(f)) {
      // Never open these files: a tracked or staged .env / secret file is a finding by itself.
      findings.push({ file: f, line: 0, rule: 'forbidden-secret-file' });
      continue;
    }
    if (matchesAny(f, SKIP_CONTENT)) continue;
    let buf: Buffer;
    if (mode === 'staged') {
      buf = gitBuffer(['show', `:${f}`], root);
    } else {
      const abs = join(root, f);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue; // deleted in working tree
      buf = readFileSync(abs);
    }
    if (looksBinary(buf)) continue;
    findings.push(...scanText(f, buf.toString('utf8')));
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv.includes('--staged') ? 'staged' : 'tree';
  const findings = scan(repoRoot(), mode);
  if (findings.length === 0) {
    console.log(`secrets: ok (${mode})`);
    process.exit(0);
  }
  console.error(`secrets: ${findings.length} potential secret(s) found (${mode}); values are not printed:`);
  for (const f of findings) console.error(`  ${f.file}${f.line ? ':' + f.line : ''}  [${f.rule}]`);
  process.exit(1);
}
