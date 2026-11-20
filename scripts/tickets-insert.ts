// `node scripts/tickets-insert.ts`: A-01 §1.2 — only services/booking may contain an INSERT into `tickets`
// (database grants are the second line of defence).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, repoRoot, zList } from './lib/git.ts';

const INSERT_TICKETS = /\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?tickets"?(?![A-Za-z0-9_])/i;
const SCANNED = ['apps', 'services', 'packages', 'eval', 'e2e', 'infra'];
// M-24: services/*/test/** may INSERT tickets as fb_owner in fixtures; DB grants (CT-06) still block runtime roles.
const ALLOWED = /^services\/(booking\/|[^/]+\/test\/)/;

export function findTicketInserts(root: string): string[] {
  const files = zList(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCANNED], root));
  const hits: string[] = [];
  for (const f of files) {
    if (ALLOWED.test(f) || !/\.(ts|tsx|js|mjs|cjs|sql|sh)$/.test(f)) continue;
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    readFileSync(abs, 'utf8')
      .split(/\r?\n/)
      .forEach((l, i) => {
        if (INSERT_TICKETS.test(l)) hits.push(`${f}:${i + 1}`);
      });
  }
  return hits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const hits = findTicketInserts(repoRoot());
  if (hits.length === 0) console.log('tickets-insert: ok (only services/booking may INSERT INTO tickets)');
  else {
    console.error('tickets-insert: INSERT INTO tickets outside services/booking:');
    for (const h of hits) console.error(`  ${h}`);
  }
  process.exit(hits.length === 0 ? 0 : 1);
}
