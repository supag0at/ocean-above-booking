import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCATIONS_DB_SHA256, PRICE_CENTS_PER_KM, type City, type Route } from '@fb/contracts/flight';
import { createFlightCore, FlightDataError } from '../src/index.ts';
import { loadNetwork, type Network } from '../src/data.ts';
import { better, cheapestPath } from '../src/route.ts';
import { ALL_NAMES, DB_BYTES, DB_PATH, RAW, SERVED, core, dist, isDirect, prng } from './helpers.ts';

const route = (a: string, b: string): Route => {
  const r = core.quoteRoute(a, b);
  if (!r.ok) throw new Error(`${a} -> ${b}: ${r.code}`);
  return r.route;
};
const path = (r: Route): string[] => [r.from, ...r.transferCities, r.to];

describe('loading (A-02 §7.6, CT-10)', () => {
  it('dataSha256 equals the contract constant', () => {
    expect(core.dataSha256).toBe(LOCATIONS_DB_SHA256);
  });
  it('refuses to start when the bytes do not hash to LOCATIONS_DB_SHA256', () => {
    const tampered = Uint8Array.from(DB_BYTES);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => loadNetwork(DB_PATH, tampered)).toThrow(FlightDataError);
    expect(() => loadNetwork(DB_PATH, tampered)).toThrow(/sha256 mismatch/u);
    // factory hashes the file at dbPath itself (M-24): any other file is refused before it is opened
    const other = `${import.meta.dirname}/../package.json`;
    expect(() => createFlightCore({ dbPath: other })).toThrow(FlightDataError);
  });
  it('opens the database read-only and leaves the file unchanged', () => {
    const src = readFileSync(new URL('../src/data.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/new DatabaseSync\(dbPath, \{ readOnly: true \}\)/u);
    expect(Buffer.compare(readFileSync(DB_PATH), DB_BYTES)).toBe(0);
  });
});

describe('task rule 3: the two tables', () => {
  it('711 cities, 40 hubs, hubs have no connected_hubs', () => {
    expect(ALL_NAMES).toHaveLength(711);
    const hubs = ALL_NAMES.filter((n) => core.getCity(n)!.isHub);
    expect(hubs).toHaveLength(40);
    for (const h of hubs) expect(core.getCity(h)!.connectedHubs).toEqual([]);
  });
  it('connected_hubs is split on ";" verbatim', () => {
    expect(core.getCity('Guangzhou')!.connectedHubs).toEqual(['Frankfurt', 'Johannesburg']);
    expect(core.getCity('Chengdu')).toMatchObject<Partial<City>>({ x: 9266, y: 4476, isHub: false, served: true });
  });
  it('getCity is exact (NFC only): no case folding or accent stripping', () => {
    expect(core.getCity('São Paulo')?.name).toBe('São Paulo');
    expect(core.getCity('São Paulo')?.name).toBe('São Paulo'); // NFD input -> NFC
    expect(core.getCity('Sao Paulo')).toBeUndefined();
    expect(core.getCity('shanghai')).toBeUndefined();
  });
});

describe('task rule 4: flights, both directions, transfers only at hubs, service', () => {
  it('every leg of every sampled route is a direct flight; interior cities are hubs', () => {
    const rnd = prng(4);
    for (let k = 0; k < 200; k++) {
      const a = SERVED[Math.floor(rnd() * SERVED.length)]!;
      const b = SERVED[Math.floor(rnd() * SERVED.length)]!;
      if (a === b) continue;
      const r = route(a, b);
      for (const l of r.legs) expect(isDirect(l.from, l.to)).toBe(true);
      for (const t of r.transferCities) expect(core.getCity(t)!.isHub).toBe(true);
    }
  });
  it('two non-hubs sharing a hub fly via that hub, never directly', () => {
    const r = route('Guangzhou', 'Tromsø'); // both connect to Frankfurt
    expect(r.legs.length).toBeGreaterThanOrEqual(2);
    expect(r.transferCities.every((t) => core.getCity(t)!.isHub)).toBe(true);
  });
  it('exactly the 10 cities with empty connected_hubs are unserved', () => {
    const unserved = ALL_NAMES.filter((n) => !core.isServed(n));
    expect(new Set(unserved)).toEqual(new Set(GOLDEN.map((g) => g[0])));
    for (const n of unserved) expect(RAW.cities.get(n)!.hubs).toEqual([]);
  });
  it('CITY_NOT_SERVED carries nearestServed (either end)', () => {
    expect(core.quoteRoute('Austin', 'Shanghai')).toEqual({
      ok: false,
      code: 'CITY_NOT_SERVED',
      nearestServed: { city: 'Copenhagen', distanceKm: '120.95' },
    });
    expect(core.quoteRoute('Shanghai', 'Iquitos')).toMatchObject({
      code: 'CITY_NOT_SERVED',
      nearestServed: { city: 'Hartford' },
    });
  });
  it('CITY_NOT_FOUND for non-canonical names, SAME_CITY for identical endpoints', () => {
    expect(core.quoteRoute('Sao Paulo', 'Shanghai')).toEqual({ ok: false, code: 'CITY_NOT_FOUND' });
    expect(core.quoteRoute('Shanghai', 'Atlantis')).toEqual({ ok: false, code: 'CITY_NOT_FOUND' });
    expect(core.quoteRoute('Shanghai', 'Shanghai')).toEqual({ ok: false, code: 'SAME_CITY' });
  });
  it('San Jose and San José are distinct canonical endpoints', () => {
    expect(route('San Jose', 'Tokyo').legs).toHaveLength(1);
    expect(route('San José', 'Sydney').legs).toHaveLength(1);
    expect(core.quoteRoute('San Jose', 'Sydney').ok).toBe(true);
  });
});

describe('task rule 5: cheapest route; direct flight when one exists', () => {
  it('every direct flight in the data is quoted as the single direct leg', () => {
    let n = 0;
    for (const a of SERVED) {
      for (const b of SERVED) {
        if (a < b && isDirect(a, b)) {
          expect(path(route(a, b))).toEqual([a, b]);
          n++;
        }
      }
    }
    expect(n).toBe(151 + 1114); // R-01 §4: 151 hub links + 1114 spokes
  });
});

describe('task rule 6: distance and price', () => {
  it('leg = Euclidean distance, total = unrounded sum, price = round(total × 13) cents', () => {
    const r = route('Shanghai', 'São Paulo');
    for (const l of r.legs) expect(l.distanceKm).toBe(dist(l.from, l.to));
    expect(r.totalDistanceKm).toBe(r.legs.reduce((s, l) => s + l.distanceKm, 0));
    expect(r.priceCents).toBe(Math.round(r.totalDistanceKm * PRICE_CENTS_PER_KM));
    expect(r.display.totalDistanceKm).toBe(r.totalDistanceKm.toFixed(2));
    expect(r.display.legs).toEqual(r.legs.map((l) => l.distanceKm.toFixed(2)));
    expect(r.display.priceUsd).toBe((r.priceCents / 100).toFixed(2));
  });
});

describe('task rule 7: the route lists every leg and transfer city', () => {
  it('legs chain from -> ... -> to and transferCities are the interior nodes', () => {
    const r = route('Chengdu', 'Wrocław');
    expect(r.legs[0]!.from).toBe('Chengdu');
    expect(r.legs.at(-1)!.to).toBe('Wrocław');
    for (let i = 1; i < r.legs.length; i++) expect(r.legs[i]!.from).toBe(r.legs[i - 1]!.to);
    expect(r.transferCities).toEqual(r.legs.slice(1).map((l) => l.from));
    expect(r.display.legs).toHaveLength(r.legs.length);
  });
});

// R-01 §4 / A-02 §7.6 golden table: [unserved, nearest served, km, second nearest].
const GOLDEN: [string, string, string, string][] = [
  ['Abu Dhabi', 'Tirana', '350.89', 'Odesa'],
  ['Stuttgart', 'Novi Sad', '175.14', 'Montego Bay'],
  ['Austin', 'Copenhagen', '120.95', 'Ohrid'],
  ['Srinagar', 'Edmonton', '226.81', 'Rome'],
  ['Pokhara', 'Townsville', '208.97', 'Santa Cruz de la Sierra'],
  ['Columbus', 'Ottawa', '114.13', 'San Antonio'],
  ['Savannah', 'Gyumri', '307.21', 'Djerba'],
  ['Fort Lauderdale', 'Xiamen', '185.61', 'Tangier'],
  ['Los Cabos', 'Basra', '280.14', 'Dakar'],
  ['Iquitos', 'Hartford', '200.66', 'Jerusalem'],
];

describe('task rule 8: nearest served city (acceptance 2)', () => {
  it.each(GOLDEN)('%s -> %s (%s km), second %s', (city, nearest, km, second) => {
    expect(core.nearestServed(city)).toEqual({ city: nearest, distanceKm: km });
    const ranked = SERVED.filter((n) => n !== city).sort((a, b) => dist(city, a) - dist(city, b));
    expect(ranked[0]).toBe(nearest);
    expect(ranked[1]).toBe(second);
    expect(dist(city, ranked[1]!)).toBeGreaterThan(dist(city, ranked[0]!)); // no tie in the golden set
  });
  it('a served city gets a nearest served city other than itself', () => {
    expect(core.nearestServed('Shanghai')?.city).not.toBe('Shanghai');
    expect(core.nearestServed('Atlantis')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// Acceptance 3: brute force over "origin -> hub path -> destination" vs Dijkstra, 300 random pairs.
// Independent implementation: raw rows from helpers, own comparator, exhaustive simple hub paths with
// a branch-and-bound cut (only paths strictly longer than best + 1e-6 are cut; weights are > 0).
// ------------------------------------------------------------------------------------------------
const EPS = 1e-6;
const hubAdj = new Map<string, string[]>();
for (const [a, b] of RAW.links) {
  hubAdj.set(a, [...(hubAdj.get(a) ?? []), b]);
  hubAdj.set(b, [...(hubAdj.get(b) ?? []), a]);
}
const cps = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0)!);
function seqLess(a: string[], b: string[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = cps(a[i]!);
    const y = cps(b[i]!);
    for (let j = 0; j < Math.min(x.length, y.length); j++) if (x[j] !== y[j]) return x[j]! < y[j]!;
    if (x.length !== y.length) return x.length < y.length;
  }
  return a.length < b.length;
}
function bruteForce(o: string, d: string): { km: number; seq: string[] } | null {
  const co = RAW.cities.get(o)!;
  const cd = RAW.cities.get(d)!;
  const access = (c: RawCityLike): string[] => (c.isHub ? [c.name] : c.hubs);
  const ends = new Set(access(cd));
  let best: { km: number; seq: string[] } | null = null;
  const offer = (seq: string[]): void => {
    let km = 0;
    for (let i = 1; i < seq.length; i++) km += dist(seq[i - 1]!, seq[i]!);
    if (
      best === null ||
      km < best.km - EPS ||
      (Math.abs(km - best.km) <= EPS &&
        (seq.length < best.seq.length || (seq.length === best.seq.length && seqLess(seq, best.seq))))
    ) {
      best = { km, seq };
    }
  };
  const dfs = (hubPath: string[], km: number): void => {
    if (best !== null && km > best.km + EPS) return;
    const last = hubPath.at(-1)!;
    if (ends.has(last)) offer([...(co.isHub ? [] : [o]), ...hubPath, ...(cd.isHub ? [] : [d])]);
    if (last === d) return; // destination hub reached: going further only revisits
    for (const nx of hubAdj.get(last) ?? []) {
      if (hubPath.includes(nx) || nx === o) continue;
      dfs([...hubPath, nx], km + dist(last, nx));
    }
  };
  for (const h of access(co)) dfs([h], co.isHub ? 0 : dist(o, h));
  return best;
}
type RawCityLike = { name: string; isHub: boolean; hubs: string[] };

describe('acceptance 3: brute-force cross-check (300 random served pairs)', () => {
  it('Dijkstra equals exhaustive enumeration, including tie-breaks', () => {
    const rnd = prng(20261119);
    let checked = 0;
    while (checked < 300) {
      const a = SERVED[Math.floor(rnd() * SERVED.length)]!;
      const b = SERVED[Math.floor(rnd() * SERVED.length)]!;
      if (a === b) continue;
      const bf = bruteForce(a, b);
      const r = core.quoteRoute(a, b);
      expect(bf).not.toBeNull();
      expect(r.ok).toBe(true);
      if (!r.ok || bf === null) continue;
      expect(path(r.route)).toEqual(bf.seq);
      expect(Math.abs(r.route.totalDistanceKm - bf.km)).toBeLessThan(EPS);
      checked++;
    }
  }, 120_000);
});

describe('acceptance 5: properties (fast-check)', () => {
  const pair = fc
    .tuple(fc.integer({ min: 0, max: SERVED.length - 1 }), fc.integer({ min: 0, max: SERVED.length - 1 }))
    .filter(([i, j]) => i !== j)
    .map(([i, j]) => [SERVED[i]!, SERVED[j]!] as const);

  it('symmetric: there and back have equal total distance', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => Math.abs(route(a, b).totalDistanceKm - route(b, a).totalDistanceKm) < EPS),
      { numRuns: 300 },
    );
  });
  it('every transfer city is a hub; path is simple; legs are direct flights', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const r = route(a, b);
        const p = path(r);
        return (
          r.transferCities.every((t) => core.getCity(t)!.isHub) &&
          new Set(p).size === p.length &&
          r.legs.every((l) => isDirect(l.from, l.to))
        );
      }),
      { numRuns: 300 },
    );
  });
  it('price = round(distance × 13) cents', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const r = route(a, b);
        return Number.isSafeInteger(r.priceCents) && r.priceCents === Math.round(r.totalDistanceKm * 13);
      }),
      { numRuns: 300 },
    );
  });
});

// ------------------------------------------------------------------------------------------------
// D-09 / M-22 tie-breaks on synthetic networks (the real data may not contain exact ties).
// ------------------------------------------------------------------------------------------------
function synthetic(cities: [string, number, number, boolean][], edges: [string, string][]): Network {
  const nodes = cities.map(([name, x, y, isHub]) => ({
    city: { name, x, y, isHub, served: true, connectedHubs: [] } as City,
    norm: name.toLowerCase(),
  }));
  const index = new Map(nodes.map((n, i) => [n.city.name, i]));
  const adj = nodes.map(() => [] as { to: number; km: number }[]);
  for (const [a, b] of edges) {
    const i = index.get(a)!;
    const j = index.get(b)!;
    const km = Math.hypot(nodes[i]!.city.x - nodes[j]!.city.x, nodes[i]!.city.y - nodes[j]!.city.y);
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }
  return { nodes, index, adj, dataSha256: '' };
}
const names = (net: Network, p: readonly number[]): string[] => p.map((i) => net.nodes[i]!.city.name);

describe('tie-breaks (D-09, M-22)', () => {
  it('equal distance: fewer legs wins', () => {
    // O(0,0) -> D(4,0): direct via hub H1 at (2,0) gives 2 legs of 2; via H2(1,0),H3(3,0) gives 3 legs.
    const net = synthetic(
      [
        ['O', 0, 0, false],
        ['A', 1, 0, true],
        ['B', 2, 0, true],
        ['C', 3, 0, true],
        ['D', 4, 0, false],
      ],
      [
        ['O', 'A'],
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
        ['O', 'B'],
        ['B', 'D'],
      ],
    );
    expect(names(net, cheapestPath(net, 0, 4)!.path)).toEqual(['O', 'B', 'D']);
  });
  it('equal distance and legs: city-name sequence by code point (uppercase before lowercase)', () => {
    const net = synthetic(
      [
        ['O', 0, 0, false],
        ['b', 1, 1, true],
        ['Z', 1, -1, true],
        ['D', 2, 0, false],
      ],
      [
        ['O', 'b'],
        ['b', 'D'],
        ['O', 'Z'],
        ['Z', 'D'],
      ],
    );
    expect(names(net, cheapestPath(net, 0, 3)!.path)).toEqual(['O', 'Z', 'D']);
  });
  it('differences below 1e-6 km count as equal; above do not', () => {
    const s = (km: number, n: string[]) => ({ km, names: n });
    expect(better(s(10 + 5e-7, ['A', 'B']), s(10, ['A', 'H', 'B']))).toBe(true); // fewer legs wins inside eps
    expect(better(s(10, ['A', 'H', 'B']), s(10 + 2e-6, ['A', 'B']))).toBe(true); // shorter wins outside eps
    expect(better(s(10, ['A', 'X', 'B']), s(10, ['A', 'X', 'B']))).toBe(false); // strict
  });
  it('non-hub cities are never transfer points', () => {
    const net = synthetic(
      [
        ['O', 0, 0, false],
        ['N', 1, 0, false],
        ['H', 1, 5, true],
        ['D', 2, 0, false],
      ],
      [
        ['O', 'N'],
        ['N', 'D'],
        ['O', 'H'],
        ['H', 'D'],
      ],
    );
    expect(names(net, cheapestPath(net, 0, 3)!.path)).toEqual(['O', 'H', 'D']);
  });
  it('unreachable -> null (NO_ROUTE)', () => {
    const net = synthetic(
      [
        ['O', 0, 0, false],
        ['H', 1, 0, true],
        ['K', 5, 0, true],
        ['D', 6, 0, false],
      ],
      [
        ['O', 'H'],
        ['K', 'D'],
      ],
    );
    expect(cheapestPath(net, 0, 3)).toBeNull();
  });
});
