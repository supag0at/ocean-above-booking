// T13a fixed cases (eval/cases/deterministic/{guards,escape_lang,render}.yaml), converted 1:1 to JSON in
// test/fixtures/*.json (no YAML dependency in the harness). The sha256 check fails when the YAML changes, so a stale
// copy cannot silently pass. Re-convert with: python services/harness/test/fixtures/convert.py
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeUserText } from '@fb/contracts/server';
import { bookingClaimGuard, normValue, numberGuard, tagGuard, type AllowSets } from '../src/guards.ts';
import { cjkRatio, langOfText } from '../src/lang.ts';
import { renderBookingConfirmed, renderBookingFailed, renderGuardNotice, renderRunContext } from '../src/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

interface Fixture {
  _source: { path: string; sha256: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form YAML case data, dispatched by `fn`
  cases: { id: string; fn: string; input: any; expect: any }[];
}
function load(name: string): Fixture {
  const f = JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8')) as Fixture;
  return f;
}

describe.each(['guards', 'escape_lang', 'render'])('fixture %s', (name) => {
  it('is in sync with the eval YAML', () => {
    const f = load(name);
    const sha = createHash('sha256')
      .update(readFileSync(join(repo, f._source.path)))
      .digest('hex');
    expect(sha).toBe(f._source.sha256);
  });
});

const n2 = (xs: string[]): string[] => xs.map((x) => normValue(x) as string);
const sets = (i: { A_price: string[]; A_dist: string[]; A_sys_extra: string[] }): AllowSets => ({
  price: new Set(n2(i.A_price)),
  dist: new Set(n2(i.A_dist)),
  sys: new Set(n2([...i.A_price, ...i.A_dist, ...i.A_sys_extra])),
});

describe('guards.yaml', () => {
  for (const c of load('guards').cases) {
    it(`${c.id} ${c.fn}`, () => {
      let hits: string[];
      if (c.fn === 'numberGuard') hits = numberGuard(c.input.text, sets(c.input));
      else if (c.fn === 'bookingClaimGuard')
        hits = bookingClaimGuard(c.input.text, c.input.bookingConfirmedInProjection);
      else if (c.fn === 'tagGuard') hits = tagGuard(c.input.text);
      else throw new Error(`unknown fn ${c.fn}`);
      expect(hits.length > 0).toBe(c.expect.violation);
      if (Array.isArray(c.expect.offending)) expect(hits).toEqual(c.expect.offending);
    });
  }
});

describe('escape_lang.yaml', () => {
  for (const c of load('escape_lang').cases) {
    it(`${c.id} ${c.fn}`, () => {
      if (c.fn === 'escapeUserText') {
        expect(escapeUserText(c.input)).toBe(c.expect);
      } else if (c.fn === 'detectLang') {
        expect(langOfText(c.input) ?? null).toBe(c.expect.lang);
        expect(Math.round((cjkRatio(c.input) ?? 0) * 10000) / 10000).toBeCloseTo(c.expect.cjkRatio, 4);
      } else throw new Error(`unknown fn ${c.fn}`);
    });
  }
});

describe('render.yaml', () => {
  for (const c of load('render').cases) {
    it(`${c.id} ${c.fn}`, () => {
      const i = c.input;
      let out: string;
      switch (c.fn) {
        case 'renderBookingConfirmed': {
          const route = i.route as string[];
          const legs = route.slice(1).map((to, k) => ({ from: route[k] as string, to }));
          out = renderBookingConfirmed({
            quoteId: i.quoteId,
            ticketId: i.ticketId,
            ticketNo: i.ticketNo,
            summary: {
              ticketNo: i.ticketNo,
              from: route[0] as string,
              to: route[route.length - 1] as string,
              legs,
              transferCities: route.slice(1, -1),
              display: i.display,
            },
          });
          break;
        }
        case 'renderBookingFailed':
          out = renderBookingFailed(i);
          break;
        case 'renderRunContext':
          out = renderRunContext({
            runId: 'run_00000000000000000000000000',
            inputSeqs: [1],
            consumedUpToSeq: 1,
            model: 'm',
            promptVersion: 'p',
            projectorVersion: 'x',
            piVersion: 'x',
            ...i,
          });
          break;
        case 'renderGuardNotice':
          out = renderGuardNotice({
            runId: 'run_00000000000000000000000000',
            attempt: 1,
            n: 0,
            messageKey: 'm',
            action: 'regenerate',
            ...i,
          });
          break;
        case 'renderUserText':
          out = escapeUserText(i);
          break;
        default:
          throw new Error(`unknown fn ${c.fn}`);
      }
      expect(out).toBe(c.expect);
    });
  }
});
