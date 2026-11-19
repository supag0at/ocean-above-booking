// Cheapest route (A-02 §7.6, D-09, M-22). Price is proportional to distance, so cheapest = shortest.
// Dijkstra over the undirected graph; only hubs are expanded (transfers at hubs only), a non-hub city
// can only be the origin or the destination. Labels are ordered by (distance with 1e-6 tolerance,
// leg count, city-name sequence by code point), compared candidate-vs-current-best (M-22 ③).
import { DISTANCE_TIE_EPSILON_KM } from '@fb/contracts/flight';
import type { Network } from './data.ts';
import { compareCodePoint } from './normalize.ts';

export interface Label {
  /** Sum of unrounded leg distances, accumulated origin → node. */
  readonly km: number;
  /** Node indices origin..node (simple path). */
  readonly path: readonly number[];
}

/** City-name sequence comparison (lexicographic over names, each compared by code point). */
export function compareSeq(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareCodePoint(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Is candidate (km, legs, names) strictly better than the current best? D-09 / M-22. */
export function better(
  a: { km: number; names: readonly string[] },
  b: { km: number; names: readonly string[] } | undefined,
): boolean {
  if (b === undefined) return true;
  if (a.km < b.km - DISTANCE_TIE_EPSILON_KM) return true;
  if (a.km > b.km + DISTANCE_TIE_EPSILON_KM) return false;
  if (a.names.length !== b.names.length) return a.names.length < b.names.length;
  return compareSeq(a.names, b.names) < 0;
}

/** Best path from `from` to `to` (indices), or null when unreachable. Assumes from !== to, both served. */
export function cheapestPath(net: Network, from: number, to: number): Label | null {
  const n = net.nodes.length;
  const best: (Label | undefined)[] = new Array<Label | undefined>(n);
  const names: (string[] | undefined)[] = new Array<string[] | undefined>(n);
  const settled = new Uint8Array(n);
  best[from] = { km: 0, path: [from] };
  names[from] = [net.nodes[from]!.city.name];
  const frontier = new Set<number>([from]);

  while (frontier.size > 0) {
    let u = -1;
    for (const v of frontier) {
      if (u === -1 || better({ km: best[v]!.km, names: names[v]! }, { km: best[u]!.km, names: names[u]! })) u = v;
    }
    frontier.delete(u);
    settled[u] = 1;
    if (u === to) return best[u]!;
    // Transfers only at hubs: a non-hub node other than the origin is a dead end.
    if (u !== from && !net.nodes[u]!.city.isHub) continue;
    const lu = best[u]!;
    const nu = names[u]!;
    for (const e of net.adj[u]!) {
      if (settled[e.to] === 1) continue;
      const cand = { km: lu.km + e.km, names: [...nu, net.nodes[e.to]!.city.name] };
      const cur = best[e.to];
      if (better(cand, cur === undefined ? undefined : { km: cur.km, names: names[e.to]! })) {
        best[e.to] = { km: cand.km, path: [...lu.path, e.to] };
        names[e.to] = cand.names;
        frontier.add(e.to);
      }
    }
  }
  return null;
}
