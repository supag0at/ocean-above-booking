// resolve_city (A-02 §7.1): read-only adapter over FlightCore.resolveCity. All matching lives in flight-core.
import type { CityMatch, ResolveResult } from '@fb/contracts/flight';
import type { ResolveCityParamsT } from '@fb/contracts/tools';
import { ok, type ToolHandler } from './types.ts';

function describeOne(m: CityMatch): string {
  if (!m.served) return 'NOT served';
  if (m.isHub) return 'hub, served';
  return `served, direct flights to ${m.connectedHubs.join(', ')}`;
}

function nearestSuffix(m: CityMatch): string {
  return m.nearestServed
    ? ` Nearest served city: ${m.nearestServed.city} (${m.nearestServed.distanceKm} km away).`
    : '';
}

function describeChoice(m: CityMatch): string {
  if (!m.served) return 'NOT served';
  if (m.isHub) return 'hub';
  return `direct flights to ${m.connectedHubs.join(', ')}`;
}

export function resolveCityText(r: ResolveResult): string {
  switch (r.status) {
    case 'exact': {
      const m = r.matches[0];
      return m ? `exact: ${m.city} (${describeOne(m)}).${nearestSuffix(m)}` : 'exact: (no match data)';
    }
    case 'ambiguous': {
      const parts = r.matches.map((m) => `'${m.city}' (${describeChoice(m)})`);
      const list = parts.length === 2 ? parts.join(' and ') : parts.join(', ');
      return `ambiguous: ${r.matches.length} different cities share this name: ${list}. Ask the user which one.`;
    }
    case 'suggest': {
      const names = r.matches.map((m) => (m.score === undefined ? m.city : `${m.city} (${m.score.toFixed(2)})`));
      return `suggest: no exact match. Closest names: ${names.join(', ')}.`;
    }
    case 'not_found':
      return 'not_found: no city with a similar name in the Ocean Above network.';
  }
}

export const resolveCity: ToolHandler = async (ctx, raw) => {
  const input = raw as ResolveCityParamsT;
  const r = ctx.deps.flightCore.resolveCity({ original: input.original, candidates: input.candidates });
  const data: Record<string, unknown> = {
    status: r.status,
    matches: r.matches.map((m) => ({ ...m, connectedHubs: [...m.connectedHubs] })),
    ...(r.matchedBy ? { matchedBy: { ...r.matchedBy } } : {}),
  };
  return ok(resolveCityText(r), data);
};
