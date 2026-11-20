// T13a deterministic eval cases (main eval/cases/deterministic, a third independent algorithm) as unit-test data.
// The JSON fixture is a verbatim conversion of the YAML (no YAML parser in the dependency set); the sha256
// check below fails if the YAML on disk changes, so the fixture cannot silently go stale.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CityMatch } from '@fb/contracts/flight';
import { normalize } from '../src/normalize.ts';
import { ALL_NAMES, RAW, core } from './helpers.ts';

interface Case {
  id: string;
  fn: string;
  input: unknown;
  expect: unknown;
}
const fixture = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/eval-deterministic.json`, 'utf8')) as {
  sources: Record<string, string>;
  cases: Case[];
};
const ROOT = `${import.meta.dirname}/../../..`;
const byFn = (fn: string): Case[] => fixture.cases.filter((c) => c.fn === fn);
const one = (fn: string): Case => byFn(fn)[0]!;

describe('fixture is in sync with eval/cases/deterministic', () => {
  it.each(Object.entries(fixture.sources))('%s sha256 unchanged', (path, sha) => {
    if (!existsSync(`${ROOT}/${path}`)) return; // tree without eval cases: fixture still runs
    expect(
      createHash('sha256')
        .update(readFileSync(`${ROOT}/${path}`))
        .digest('hex'),
    ).toBe(sha);
  });
  it('covers every function', () => {
    expect(byFn('quote')).toHaveLength(49);
    expect(byFn('norm')).toHaveLength(20);
    expect(byFn('resolve_city')).toHaveLength(27);
    expect(byFn('save_preference')).toHaveLength(8);
    expect(byFn('nearestServed')).toHaveLength(10);
  });
});

describe('quote (det-route-*)', () => {
  it.each(byFn('quote').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const { from, to } = c.input as { from: string; to: string };
    const exp = c.expect as Record<string, unknown>;
    const r = core.quoteRoute(from, to);
    if (r.ok) {
      const got: Record<string, unknown> = {
        ok: true,
        path: [r.route.from, ...r.route.transferCities, r.route.to],
        ...r.route,
      };
      for (const k of Object.keys(exp)) expect(got[k], k).toEqual(exp[k]);
    } else {
      expect(r.ok).toBe(exp['ok']);
      expect(r.code).toBe(exp['code']);
      const data = exp['data'] as { nearestServed?: unknown } | undefined;
      if (data?.nearestServed !== undefined) expect(r.nearestServed).toEqual(data.nearestServed);
    }
  });
});

describe('norm (det-norm-*)', () => {
  it.each(byFn('norm').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(normalize(c.input as string)).toBe(c.expect);
  });
  it('normCollisions / allAsciiAfterNorm', () => {
    const groups = new Map<string, string[]>();
    for (const n of ALL_NAMES) groups.set(normalize(n), [...(groups.get(normalize(n)) ?? []), n]);
    const collided = [...groups.values()].filter((g) => g.length > 1).flat();
    expect(new Set(collided)).toEqual(new Set(one('normCollisions').expect as string[]));
    expect(ALL_NAMES.every((n) => /^[\x20-\x7e]*$/u.test(normalize(n)))).toBe(one('allAsciiAfterNorm').expect);
  });
});

describe('resolve_city (det-resolve-*)', () => {
  it.each(byFn('resolve_city').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const exp = c.expect as { status: string; matches: Partial<CityMatch>[]; matchedBy?: Record<string, unknown> };
    const r = core.resolveCity(c.input as { original: string; candidates: string[] });
    expect(r.status).toBe(exp.status);
    expect(r.matches).toHaveLength(exp.matches.length);
    // the case lists the fields it asserts; compare exactly those (connectedHubs order is the DB order)
    exp.matches.forEach((m, i) => {
      for (const [k, v] of Object.entries(m))
        expect((r.matches[i] as Record<string, unknown>)[k], `${i}.${k}`).toEqual(v);
    });
    if (exp.matchedBy !== undefined) expect(r.matchedBy).toMatchObject(exp.matchedBy);
  });
});

describe('save_preference home_city normalisation (det-pref-*, A-02 §7.5 via resolveCity)', () => {
  it.each(byFn('save_preference').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const { value } = c.input as { key: string; value: string };
    const exp = c.expect as { ok: boolean; stored?: string; code?: string };
    const r = core.resolveCity({ original: '', candidates: [value] });
    if (exp.ok) {
      expect(r.status).toBe('exact');
      expect(r.matches[0]!.city).toBe(exp.stored);
    } else {
      expect(r.status === 'ambiguous' ? 'CITY_AMBIGUOUS' : r.status === 'exact' ? 'OK' : 'INVALID_INPUT').toBe(
        exp.code,
      );
    }
  });
});

describe('nearestServed (det-nearest-*)', () => {
  it.each(byFn('nearestServed').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const { city } = c.input as { city: string };
    const exp = c.expect as { served: boolean; nearestServed: unknown };
    expect(core.isServed(city)).toBe(exp.served);
    expect(core.nearestServed(city)).toEqual(exp.nearestServed);
  });
  it('unservedSet', () => {
    const exp = one('unservedSet').expect as { unserved: string[]; cities: number; hubs: number; hubLinks: number };
    expect(ALL_NAMES.filter((n) => !core.isServed(n))).toEqual(exp.unserved);
    expect(ALL_NAMES).toHaveLength(exp.cities);
    expect(ALL_NAMES.filter((n) => core.getCity(n)!.isHub)).toHaveLength(exp.hubs);
    expect(RAW.links).toHaveLength(exp.hubLinks);
  });
});
