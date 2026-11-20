// Test stand-in for flight-core (A-02 §7.1, §7.6). Small fixed graph; implements the FlightCore interface only.
import type {
  City,
  CityMatch,
  Leg,
  MatchedBy,
  NearestServed,
  ResolveCityInput,
  ResolveResult,
  Route,
  RouteResult,
} from '@fb/contracts/flight';
import {
  LOCATIONS_DB_SHA256,
  PRICE_CENTS_PER_KM,
  TRANSLITERATION_TABLE,
  ZERO_WIDTH_CHARS_PATTERN,
} from '@fb/contracts/flight';
import type { CreateFlightCore } from '../../src/ports.ts';

interface FakeCityDef {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly isHub: boolean;
  readonly connectedHubs: readonly string[];
}

const hub = (name: string, x: number, y: number): FakeCityDef => ({ name, x, y, isHub: true, connectedHubs: [] });
const spoke = (name: string, x: number, y: number, connectedHubs: readonly string[]): FakeCityDef => ({
  name,
  x,
  y,
  isHub: false,
  connectedHubs,
});

const CITY_DEFS: readonly FakeCityDef[] = [
  hub('Shanghai', 0, 0),
  hub('Dubai', 3000, 4000),
  hub('São Paulo', 3000, 10000),
  hub('Tokyo', 0, -3000),
  hub('Sydney', 4000, -3000),
  hub('Reykjavik', -9000, 0),
  spoke('San Jose', 0, -3300, ['Tokyo']),
  spoke('San José', 4000, -3300, ['Sydney', 'Tokyo']),
  spoke('Tromsø', 3000, 4500, ['Dubai']),
  spoke('Copenhagen', 10000, 10120, ['Dubai']),
  spoke('Zürich', 100, 100, ['Shanghai']),
  spoke('Zurrieq', 200, 200, ['Shanghai']),
  spoke('Austin', 10000, 10000, []),
];

const HUB_LINKS: readonly (readonly [string, string])[] = [
  ['Shanghai', 'Dubai'],
  ['Dubai', 'São Paulo'],
  ['Shanghai', 'Tokyo'],
  ['Tokyo', 'Sydney'],
];

export const FAKE_CITIES: readonly City[] = CITY_DEFS.map((d) => ({
  name: d.name.normalize('NFC'),
  x: d.x,
  y: d.y,
  isHub: d.isHub,
  served: d.isHub || d.connectedHubs.length > 0,
  connectedHubs: d.connectedHubs,
}));

const ZERO_WIDTH_RE = new RegExp(ZERO_WIDTH_CHARS_PATTERN, 'gu');

function normalize(s: string): string {
  const step1 = s.normalize('NFKC').replace(ZERO_WIDTH_RE, '');
  let step2 = '';
  for (const ch of step1) step2 += TRANSLITERATION_TABLE[ch] ?? ch;
  const step3 = step2.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const step4 = step3.replace(/['’.]/gu, '');
  return step4.replace(/[^0-9a-z]+/gu, ' ').trim();
}

/** Restricted Damerau-Levenshtein (optimal string alignment) distance. */
function osa(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= m; j++) row.push(i === 0 ? j : j === 0 ? i : 0);
    d.push(row);
  }
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, at(i - 2, j - 2) + 1);
      }
      const row = d[i];
      if (row) row[j] = v;
    }
  }
  return at(n, m);
}

function dist(a: City, b: City): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function codePointLess(a: string, b: string): boolean {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const len = Math.min(ca.length, cb.length);
  for (let i = 0; i < len; i++) {
    const x = (ca[i] ?? '').codePointAt(0) ?? 0;
    const y = (cb[i] ?? '').codePointAt(0) ?? 0;
    if (x !== y) return x < y;
  }
  return ca.length < cb.length;
}

function seqLess(a: readonly string[], b: readonly string[]): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x !== y) return codePointLess(x, y);
  }
  return a.length < b.length;
}

/** Same signature as T03's `createFlightCore({ dbPath })`; the fixed graph ignores the file. */
export const createFakeFlightCore: CreateFlightCore = ({ dbPath }) => {
  if (dbPath === '') throw new Error('dbPath required');
  const byName = new Map<string, City>();
  for (const c of FAKE_CITIES) byName.set(c.name, c);
  const normByName = new Map<string, string>();
  const byNorm = new Map<string, City[]>();
  for (const c of FAKE_CITIES) {
    const n = normalize(c.name);
    normByName.set(c.name, n);
    const list = byNorm.get(n) ?? [];
    list.push(c);
    byNorm.set(n, list);
  }

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string): void => {
    let set = adjacency.get(a);
    if (!set) {
      set = new Set();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  const link = (a: string, b: string): void => {
    addEdge(a, b);
    addEdge(b, a);
  };
  for (const [a, b] of HUB_LINKS) link(a, b);
  for (const c of FAKE_CITIES) for (const h of c.connectedHubs) link(c.name, h);

  const getCity = (name: string): City | undefined => byName.get(name.normalize('NFC'));
  const isServed = (name: string): boolean => getCity(name)?.served ?? false;

  const nearestServed = (name: string): NearestServed | null => {
    const city = getCity(name);
    if (!city || city.served) return null;
    let best: City | undefined;
    let bestD = Infinity;
    let bestNorm = '';
    for (const c of FAKE_CITIES) {
      if (!c.served || c.name === city.name) continue;
      const d = dist(city, c);
      const n = normByName.get(c.name) ?? '';
      if (d < bestD || (d === bestD && codePointLess(n, bestNorm))) {
        best = c;
        bestD = d;
        bestNorm = n;
      }
    }
    return best ? { city: best.name, distanceKm: bestD.toFixed(2) } : null;
  };

  const toMatch = (c: City, score?: number): CityMatch => {
    const base = {
      city: c.name,
      isHub: c.isHub,
      served: c.served,
      connectedHubs: c.connectedHubs,
      nearestServed: c.served ? null : nearestServed(c.name),
    };
    return score === undefined ? base : { ...base, score };
  };

  const resolveCity = (input: ResolveCityInput): ResolveResult => {
    const items = [...input.candidates, input.original];
    for (let i = 0; i < items.length; i++) {
      const n = normalize(items[i] ?? '');
      if (n === '') continue;
      const hits = byNorm.get(n);
      if (!hits || hits.length === 0) continue;
      const matchedBy: MatchedBy =
        i < input.candidates.length ? { source: 'candidate', index: i } : { source: 'original' };
      return {
        status: hits.length === 1 ? 'exact' : 'ambiguous',
        matches: hits.map((c) => toMatch(c)),
        matchedBy,
      };
    }

    const best = new Map<string, { score: number; index: number }>();
    input.candidates.forEach((cand, index) => {
      const cn = normalize(cand);
      if (cn === '') return;
      for (const c of FAKE_CITIES) {
        const nn = normByName.get(c.name) ?? '';
        if (nn === '') continue;
        let score = 0;
        if (nn.startsWith(cn) || cn.startsWith(nn)) score = 0.92;
        else if (nn.includes(cn) || cn.includes(nn)) score = 0.88;
        else {
          const maxLen = Math.max(cn.length, nn.length);
          const d = osa(cn, nn);
          if (d <= Math.max(1, Math.floor(maxLen / 4))) score = 1 - d / maxLen;
        }
        score = Math.round(score * 1e4) / 1e4; // T03 keeps 4 decimals
        if (score <= 0) continue;
        const prev = best.get(c.name);
        if (!prev || score > prev.score) best.set(c.name, { score, index });
      }
    });
    const ranked = [...best.entries()]
      .filter(([, v]) => v.score >= 0.6)
      .sort(([an, a], [bn, b]) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.index !== b.index) return a.index - b.index;
        const x = normByName.get(an) ?? '';
        const y = normByName.get(bn) ?? '';
        return x === y ? 0 : codePointLess(x, y) ? -1 : 1;
      })
      .slice(0, 5);
    if (ranked.length === 0) return { status: 'not_found', matches: [] };
    const matches: CityMatch[] = [];
    for (const [name, v] of ranked) {
      const c = byName.get(name);
      if (c) matches.push(toMatch(c, v.score));
    }
    return { status: 'suggest', matches, matchedBy: { source: 'fuzzy' } };
  };

  const quoteRoute = (fromIn: string, toIn: string): RouteResult => {
    const from = getCity(fromIn);
    const to = getCity(toIn);
    if (!from || !to) return { ok: false, code: 'CITY_NOT_FOUND' };
    if (from.name === to.name) return { ok: false, code: 'SAME_CITY' };
    const unserved = !from.served ? from : !to.served ? to : undefined;
    if (unserved) {
      const ns = nearestServed(unserved.name);
      return ns ? { ok: false, code: 'CITY_NOT_SERVED', nearestServed: ns } : { ok: false, code: 'CITY_NOT_SERVED' };
    }

    let bestPath: string[] | undefined;
    let bestTotal = Infinity;
    const eps = 1e-6;
    const consider = (path: string[]): void => {
      let total = 0;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = byName.get(path[i] ?? '');
        const b = byName.get(path[i + 1] ?? '');
        if (a && b) total += dist(a, b);
      }
      let better = false;
      if (!bestPath) better = true;
      else if (total < bestTotal - eps) better = true;
      else if (Math.abs(total - bestTotal) < eps) {
        if (path.length !== bestPath.length) better = path.length < bestPath.length;
        else better = seqLess(path, bestPath);
      }
      if (better) {
        bestPath = path;
        bestTotal = total;
      }
    };
    const dfs = (path: string[]): void => {
      const cur = path[path.length - 1] ?? '';
      for (const nb of adjacency.get(cur) ?? []) {
        if (path.includes(nb)) continue;
        if (nb === to.name) {
          consider([...path, nb]);
        } else if (byName.get(nb)?.isHub) {
          dfs([...path, nb]);
        }
      }
    };
    dfs([from.name]);
    if (!bestPath) return { ok: false, code: 'NO_ROUTE' };
    const finalPath: string[] = bestPath;

    const legs: Leg[] = [];
    for (let i = 0; i + 1 < finalPath.length; i++) {
      const a = byName.get(finalPath[i] ?? '');
      const b = byName.get(finalPath[i + 1] ?? '');
      if (a && b) legs.push({ from: a.name, to: b.name, distanceKm: dist(a, b) });
    }
    const totalDistanceKm = legs.reduce((s, l) => s + l.distanceKm, 0);
    const priceCents = Math.round(totalDistanceKm * PRICE_CENTS_PER_KM);
    const route: Route = {
      from: from.name,
      to: to.name,
      legs,
      transferCities: finalPath.slice(1, -1),
      totalDistanceKm,
      priceCents,
      display: {
        legs: legs.map((l) => l.distanceKm.toFixed(2)),
        totalDistanceKm: totalDistanceKm.toFixed(2),
        priceUsd: (priceCents / 100).toFixed(2),
      },
    };
    return { ok: true, route };
  };

  return { normalize, getCity, isServed, nearestServed, resolveCity, quoteRoute, dataSha256: LOCATIONS_DB_SHA256 };
};
