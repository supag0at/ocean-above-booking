// Static contract-package rules (CONTRACT-v1 M-11, M-12, M-15). Contract tests may read files
// (the depcruise rule `contracts-forbidden` only covers src/).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const ENTRIES = ['web', 'flight', 'tools', 'server'] as const;
type Entry = (typeof ENTRIES)[number];

const files = (entry: Entry): { name: string; text: string }[] =>
  readdirSync(join(SRC, entry))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: `${entry}/${f}`, text: readFileSync(join(SRC, entry, f), 'utf8') }));
const all = ENTRIES.flatMap(files);

/** Entries imported (relative path) by an entry's files. */
function importedEntries(entry: Entry): Set<string> {
  const out = new Set<string>();
  for (const f of files(entry)) {
    for (const m of f.text.matchAll(/(?:from|import)\s*\(?\s*['"]\.\.\/([a-z]+)\//g)) out.add(m[1] ?? '');
  }
  return out;
}

describe('M-11 entry layering: web <- flight <- tools <- server', () => {
  const allowed: Record<Entry, Entry[]> = {
    web: [],
    flight: ['web'],
    tools: ['web', 'flight'],
    server: ['web', 'flight', 'tools'],
  };
  for (const entry of ENTRIES) {
    it(`${entry} imports only ${allowed[entry].join(', ') || 'nothing'}`, () => {
      for (const target of importedEntries(entry)) expect(allowed[entry]).toContain(target);
    });
  }
  it('no entry imports through the package name', () => {
    for (const f of all) expect(f.text).not.toMatch(/from\s+['"]@fb\//);
  });
});

describe('M-15 no JSON-Schema format keyword', () => {
  it('src has no `format` keyword in any schema', () => {
    for (const f of all) {
      expect(f.text, f.name).not.toMatch(/\bformat\s*:/);
      expect(f.text, f.name).not.toMatch(/['"]format['"]\s*:/);
    }
  });
});

describe('M-12 single definitions', () => {
  const count = (re: RegExp) => all.filter((f) => re.test(f.text)).map((f) => f.name);
  it('ErrorCode literal list exists only in web (tools keeps the AGENT_ERROR_CODES subset)', () => {
    expect(count(/AUTH_REQUIRED/)).toEqual(['web/errors.ts']);
    expect(count(/CONTEXT_CORRUPT/).sort()).toEqual(['tools/index.ts', 'web/errors.ts']);
  });
  it('Quote / TicketView / TicketSummary schemas exist only in web', () => {
    expect(count(/export const QuoteSchema\b/)).toEqual(['web/views.ts']);
    expect(count(/export const TicketViewSchema\b/)).toEqual(['web/views.ts']);
    expect(count(/export const TicketSummarySchema\b/)).toEqual(['web/views.ts']);
    expect(count(/\b(QuoteSnapshot|TicketRecord)\b/)).toEqual([]);
  });
  it('execute envelope only in tools; key builders only in server; per-km rate only in flight', () => {
    expect(count(/ExecuteRequestSchema\s*=/)).toEqual(['tools/index.ts']);
    expect(count(/HandsExecute(Request|Response)\s*=/)).toEqual([]);
    expect(count(/export (?:const|function) toolResultMessageKey/)).toEqual(['server/keys.ts']);
    expect(count(/quoteOfferedIdempotencyKey/)).toEqual([]);
    expect(count(/PRICE_PER_KM_USD\s*=/)).toEqual(['flight/index.ts']);
  });
  it('no TODO(T01-REVIEW) marker is left (only REVIEW2 is allowed)', () => {
    for (const f of all) expect(f.text, f.name).not.toMatch(/TODO\(T01-REVIEW\)/);
  });
});
