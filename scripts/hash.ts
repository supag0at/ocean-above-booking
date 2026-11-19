// `pnpm hash`: verify the sha256 of locations.db (A-01 §1.1, H-02 read-only data source).
// The expected value is duplicated in @fb/contracts/server by T01; a contract test keeps them equal.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './lib/git.ts';

export const LOCATIONS_DB_SHA256 = 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f';

export function checkHash(root: string): { ok: boolean; message: string } {
  const file = join(root, 'locations.db');
  if (!existsSync(file)) return { ok: false, message: `hash: ${file} is missing` };
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== LOCATIONS_DB_SHA256) {
    return {
      ok: false,
      message: `hash: locations.db sha256 mismatch\n  expected ${LOCATIONS_DB_SHA256}\n  actual   ${actual}`,
    };
  }
  return { ok: true, message: `hash: locations.db ok (${actual})` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = checkHash(repoRoot());
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}
