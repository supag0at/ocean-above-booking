// Loading locations.db (A-02 §7.6, H-03, CT-10): sha256 check, read-only open, graph construction.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LOCATIONS_DB_SHA256, type City } from '@fb/contracts/flight';
import { normalize } from './normalize.ts';

export interface Node {
  readonly city: City;
  readonly norm: string;
}

/** Adjacency: neighbour index + float64 Euclidean distance (unrounded). */
export interface Edge {
  readonly to: number;
  readonly km: number;
}

export interface Network {
  readonly nodes: readonly Node[];
  readonly index: ReadonlyMap<string, number>;
  readonly adj: readonly (readonly Edge[])[];
  readonly dataSha256: string;
}

export class FlightDataError extends Error {
  override readonly name = 'FlightDataError';
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function euclid(a: City, b: City): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

interface LocationRow {
  city_name: string;
  coordinate: string;
  is_hub: number;
  connected_hubs: string;
}
interface LinkRow {
  hub_a: string;
  hub_b: string;
}

const COORD = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u;

/**
 * Verifies `dbBytes` against LOCATIONS_DB_SHA256 BEFORE opening anything, then opens `dbPath`
 * read-only. Throws FlightDataError on any mismatch or malformed row (refuse to start).
 */
export function loadNetwork(dbPath: string, dbBytes: Uint8Array): Network {
  const dataSha256 = sha256Hex(dbBytes);
  if (dataSha256 !== LOCATIONS_DB_SHA256) {
    throw new FlightDataError(`locations.db sha256 mismatch: expected ${LOCATIONS_DB_SHA256}, got ${dataSha256}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: LocationRow[];
  let links: LinkRow[];
  try {
    rows = db
      .prepare('SELECT city_name, coordinate, is_hub, connected_hubs FROM locations ORDER BY city_name')
      .all() as unknown as LocationRow[];
    links = db.prepare('SELECT hub_a, hub_b FROM hub_links').all() as unknown as LinkRow[];
  } finally {
    db.close();
  }

  const parsed = rows.map((r) => {
    const m = COORD.exec(r.coordinate);
    if (m === null) throw new FlightDataError(`bad coordinate for ${r.city_name}: ${r.coordinate}`);
    const isHub = r.is_hub === 1;
    const connectedHubs = isHub
      ? []
      : r.connected_hubs
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s !== '');
    return { name: r.city_name, x: Number(m[1]), y: Number(m[2]), isHub, connectedHubs };
  });

  const index = new Map<string, number>();
  parsed.forEach((p, i) => {
    if (index.has(p.name)) throw new FlightDataError(`duplicate city_name ${p.name}`);
    index.set(p.name, i);
  });
  const hubIdx = (name: string, ctx: string): number => {
    const i = index.get(name);
    if (i === undefined || parsed[i]?.isHub !== true) throw new FlightDataError(`${ctx}: ${name} is not a hub`);
    return i;
  };

  const nodes: Node[] = parsed.map((p) => {
    const city: City = Object.freeze({
      name: p.name,
      x: p.x,
      y: p.y,
      isHub: p.isHub,
      served: p.isHub || p.connectedHubs.length > 0,
      connectedHubs: Object.freeze([...p.connectedHubs]),
    });
    return { city, norm: normalize(p.name) };
  });

  // Undirected graph; de-duplicated edges (hub_links may list a pair in both directions).
  const adjSets = nodes.map(() => new Set<number>());
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    adjSets[a]?.add(b);
    adjSets[b]?.add(a);
  };
  for (const l of links) addEdge(hubIdx(l.hub_a, 'hub_links'), hubIdx(l.hub_b, 'hub_links'));
  nodes.forEach((n, i) => {
    for (const h of n.city.connectedHubs) addEdge(i, hubIdx(h, `connected_hubs of ${n.city.name}`));
  });
  const adj: Edge[][] = adjSets.map((set, i) => {
    const from = nodes[i]!.city;
    return [...set].sort((a, b) => a - b).map((to) => ({ to, km: euclid(from, nodes[to]!.city) }));
  });

  return { nodes, index, adj, dataSha256 };
}
