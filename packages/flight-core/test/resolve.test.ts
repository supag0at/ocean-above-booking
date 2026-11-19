import { describe, expect, it } from 'vitest';
import { damerauLevenshtein, fuzzyScore } from '../src/resolve.ts';
import { core } from './helpers.ts';

const resolve = (candidates: string[], original = candidates[0] ?? '') => core.resolveCity({ original, candidates });

describe('resolveCity exact / ambiguous (acceptance 4)', () => {
  it.each(['San Jose', 'San José', 'san jose', 'SAN JOSÉ'])('%s -> ambiguous between both cities', (q) => {
    const r = resolve([q]);
    expect(r.status).toBe('ambiguous');
    expect(r.matches.map((m) => m.city)).toEqual(['San Jose', 'San José']);
    expect(r.matches[0]!.connectedHubs).toEqual(['Tokyo']);
    expect([...r.matches[1]!.connectedHubs].sort()).toEqual(['Sydney', 'Tokyo']);
  });

  it.each([
    ['Sao Paulo', 'São Paulo'],
    ['sao paulo', 'São Paulo'],
    ['zurich', 'Zürich'],
    ['Tromsø', 'Tromsø'],
    ['Tromso', 'Tromsø'],
    ['Wrocław', 'Wrocław'],
    ['wroclaw', 'Wrocław'],
    ['SHANGHAI', 'Shanghai'],
  ])('%s -> exact %s', (q, city) => {
    const r = resolve([q]);
    expect(r.status).toBe('exact');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.city).toBe(city);
    expect(r.matchedBy).toEqual({ source: 'candidate', index: 0 });
  });

  it('stops at the first candidate that hits, in order', () => {
    const r = resolve(['Atlantis', 'Shanghai', 'Beijing'], '上海');
    expect(r.status).toBe('exact');
    expect(r.matches[0]!.city).toBe('Shanghai');
    expect(r.matchedBy).toEqual({ source: 'candidate', index: 1 });
  });

  it('falls back to original after all candidates', () => {
    const r = core.resolveCity({ original: 'Zürich', candidates: ['Atlantis'] });
    expect(r.status).toBe('exact');
    expect(r.matchedBy).toEqual({ source: 'original' });
  });

  it('unserved exact match carries nearestServed', () => {
    const r = resolve(['austin']);
    expect(r.status).toBe('exact');
    expect(r.matches[0]).toMatchObject({
      city: 'Austin',
      served: false,
      nearestServed: { city: 'Copenhagen', distanceKm: '120.95' },
    });
  });

  it('served match has nearestServed null', () => {
    expect(resolve(['Shanghai']).matches[0]!.nearestServed).toBeNull();
  });
});

describe('resolveCity fuzzy', () => {
  it('a typo gives suggest, never exact', () => {
    const r = resolve(['Zurih']);
    expect(r.status).toBe('suggest');
    expect(r.matches[0]!.city).toBe('Zürich');
    expect(r.matchedBy).toEqual({ source: 'fuzzy', index: 0 });
  });

  it('prefix gives suggest', () => {
    const r = resolve(['Shangh']);
    expect(r.status).toBe('suggest');
    expect(r.matches.map((m) => m.city)).toContain('Shanghai');
  });

  it('original is not used for fuzzy matching', () => {
    expect(core.resolveCity({ original: 'Zurih', candidates: ['Qqqqqqqq'] }).status).toBe('not_found');
  });

  it('returns at most 5 matches', () => {
    const r = resolve(['San']);
    expect(r.status).toBe('suggest');
    expect(r.matches.length).toBeLessThanOrEqual(5);
  });

  it('not_found for non-Latin input and nonsense', () => {
    expect(resolve(['上海'])).toEqual({ status: 'not_found', matches: [] });
    expect(resolve(['Xqzvbnmw'])).toEqual({ status: 'not_found', matches: [] });
  });

  it('S-6 scoring', () => {
    expect(fuzzyScore('shang', 'shanghai')).toBe(0.92);
    expect(fuzzyScore('shanghai city', 'shanghai')).toBe(0.92);
    expect(fuzzyScore('paulo', 'sao paulo')).toBe(0.88);
    expect(fuzzyScore('zurih', 'zurich')).toBeCloseTo(1 - 1 / 6);
    expect(fuzzyScore('abcdefgh', 'zzzzzzzz')).toBe(0);
    expect(fuzzyScore('', 'paris')).toBe(0);
    expect(damerauLevenshtein('zuirch', 'zurich')).toBe(1); // transposition counts 1
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
  });
});
