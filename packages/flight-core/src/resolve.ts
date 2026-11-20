// resolve_city matching flow (A-02 §7.1, D-37, S-6).
import type { CityMatch, NearestServed, ResolveCityInput, ResolveResult } from '@fb/contracts/flight';
import type { Network } from './data.ts';
import { compareCodePoint, normalize } from './normalize.ts';

export const MAX_MATCHES = 5;
export const MIN_FUZZY_SCORE = 0.6;
export const SCORE_PREFIX = 0.92;
export const SCORE_CONTAINS = 0.88;

/** Optimal-string-alignment Damerau-Levenshtein distance (adjacent transpositions count 1), over code points. */
export function damerauLevenshtein(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  const m = s.length;
  const n = t.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

/** S-6 score of a normalised query against a normalised city name; 0 when below threshold. */
export function fuzzyScore(q: string, c: string): number {
  if (q === '' || c === '') return 0;
  if (c.startsWith(q) || q.startsWith(c)) return SCORE_PREFIX;
  if (c.includes(q) || q.includes(c)) return SCORE_CONTAINS;
  const maxLen = Math.max([...q].length, [...c].length);
  const dist = damerauLevenshtein(q, c);
  if (dist <= Math.max(1, Math.floor(maxLen / 4))) return 1 - dist / maxLen;
  return 0;
}

/** M-24 `score`: fuzzy score rounded to 4 decimals (same form as the T13a eval cases); ranking uses the raw score. */
export function roundScore(score: number): number {
  return Math.round(score * 1e4) / 1e4;
}

export function toMatch(
  net: Network,
  i: number,
  nearest: (i: number) => NearestServed | null,
  score?: number,
): CityMatch {
  const c = net.nodes[i]!.city;
  return {
    ...(score === undefined ? {} : { score: roundScore(score) }),
    city: c.name,
    isHub: c.isHub,
    served: c.served,
    connectedHubs: c.connectedHubs,
    nearestServed: c.served ? null : nearest(i),
  };
}

export function resolveCity(
  net: Network,
  byNorm: ReadonlyMap<string, readonly number[]>,
  input: ResolveCityInput,
  nearest: (i: number) => NearestServed | null,
): ResolveResult {
  // 1. Exact on norm: candidates in order, then original last; stop at the first item that hits.
  const items: { q: string; matchedBy: ResolveResult['matchedBy'] }[] = [
    ...input.candidates.map((q, index) => ({ q, matchedBy: { source: 'candidate' as const, index } })),
    { q: input.original, matchedBy: { source: 'original' as const } },
  ];
  for (const it of items) {
    const key = normalize(it.q);
    if (key === '') continue;
    const hit = byNorm.get(key);
    if (hit === undefined || hit.length === 0) continue;
    const matches = hit.slice(0, MAX_MATCHES).map((i) => toMatch(net, i, nearest));
    return {
      status: hit.length === 1 ? 'exact' : 'ambiguous',
      matches,
      ...(it.matchedBy === undefined ? {} : { matchedBy: it.matchedBy }),
    };
  }

  // 2. Fuzzy over candidates only (never original); merge per city keeping the best score,
  //    ties -> earlier candidate, then normalised name, then raw name (code point).
  const bestPer = new Map<number, { score: number; cand: number }>();
  input.candidates.forEach((raw, cand) => {
    const q = normalize(raw);
    if (q === '') return;
    net.nodes.forEach((node, i) => {
      const score = fuzzyScore(q, node.norm);
      if (score < MIN_FUZZY_SCORE) return;
      const cur = bestPer.get(i);
      if (cur === undefined || score > cur.score) bestPer.set(i, { score, cand });
    });
  });
  const ranked = [...bestPer.entries()].sort(([ia, a], [ib, b]) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.cand !== b.cand) return a.cand - b.cand;
    const na = net.nodes[ia]!;
    const nb = net.nodes[ib]!;
    return compareCodePoint(na.norm, nb.norm) || compareCodePoint(na.city.name, nb.city.name);
  });
  const top = ranked.slice(0, MAX_MATCHES);
  if (top.length === 0) return { status: 'not_found', matches: [] };
  return {
    status: 'suggest',
    matches: top.map(([i, m]) => toMatch(net, i, nearest, m.score)),
    matchedBy: { source: 'fuzzy', index: top[0]![1].cand },
  };
}
