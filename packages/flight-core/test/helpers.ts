// Test helpers: one shared FlightCore over the repo's locations.db, plus an INDEPENDENT raw reader
// (its own SQL + parsing) used by the brute-force cross-check so it does not reuse src/data.ts.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createFlightCore } from '../src/index.ts';

export const DB_PATH = `${import.meta.dirname}/../../../locations.db`;
export const DB_BYTES = readFileSync(DB_PATH);

export const core = createFlightCore({ dbPath: DB_PATH });

export interface RawCity {
  name: string;
  x: number;
  y: number;
  isHub: boolean;
  hubs: string[];
}

export function readRaw(): { cities: Map<string, RawCity>; links: [string, string][] } {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const cities = new Map<string, RawCity>();
    for (const r of db.prepare('SELECT * FROM locations').all()) {
      const [x, y] = String(r['coordinate']).split(',').map(Number);
      const isHub = r['is_hub'] === 1;
      const hubs = String(r['connected_hubs'])
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      cities.set(String(r['city_name']), { name: String(r['city_name']), x: x!, y: y!, isHub, hubs });
    }
    const links = db
      .prepare('SELECT hub_a, hub_b FROM hub_links')
      .all()
      .map((r) => [String(r['hub_a']), String(r['hub_b'])] as [string, string]);
    return { cities, links };
  } finally {
    db.close();
  }
}

export const RAW = readRaw();
export const ALL_NAMES = [...RAW.cities.keys()].sort();
export const SERVED = ALL_NAMES.filter((n) => {
  const c = RAW.cities.get(n)!;
  return c.isHub || c.hubs.length > 0;
});

export function dist(a: string, b: string): number {
  const p = RAW.cities.get(a)!;
  const q = RAW.cities.get(b)!;
  // sqrt(dx²+dy²), NOT Math.hypot: with integer coordinates dx², dy² and their sum are exact, so this is
  // the correctly rounded distance and matches the T04 Python oracle bit for bit; hypot can differ by 1 ulp.
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Direct flight per task rule 4, from the raw rows. */
export function isDirect(a: string, b: string): boolean {
  const p = RAW.cities.get(a)!;
  const q = RAW.cities.get(b)!;
  if (p.isHub && q.isHub) return RAW.links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (p.isHub && !q.isHub) return q.hubs.includes(a);
  if (!p.isHub && q.isHub) return p.hubs.includes(b);
  return false;
}

/** Deterministic PRNG (mulberry32) for the sampled cross-check. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
