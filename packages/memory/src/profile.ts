// Derived profile (A-02 §9.1): computed from tickets on every read, never stored. Pure functions.
import type { ProfileSnapshot } from '@fb/contracts/server';
import { recallPreferences } from './recall.ts';
import type { MemoryDeletionRow, MemoryRow, MemoryStore, TicketRow } from './types.ts';

/** Code-point-order comparison (not localeCompare), consistent with M-22 / A-02 §4.3. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function deriveFrequentRoutes(tickets: readonly TicketRow[]): ProfileSnapshot['frequentRoutes'] {
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const t of tickets) {
    const k = JSON.stringify([t.from, t.to]); // original city_name, no normalisation (A-01 §3.2)
    const e = counts.get(k);
    if (e) e.count += 1;
    else counts.set(k, { from: t.from, to: t.to, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || cmp(a.from, b.from) || cmp(a.to, b.to)).slice(0, 3);
}

/** Latest ticket by bookedAt, ties broken by ticketId (larger wins) so the result is order-independent. */
export function deriveLastTicket(tickets: readonly TicketRow[]): ProfileSnapshot['lastTicket'] {
  let best: TicketRow | undefined;
  let bestMs = 0;
  for (const t of tickets) {
    const ms = Date.parse(t.bookedAt);
    if (Number.isNaN(ms)) throw new RangeError(`invalid bookedAt on ticket ${t.ticketId}`);
    if (best === undefined || ms > bestMs || (ms === bestMs && t.ticketId > best.ticketId)) {
      best = t;
      bestMs = ms;
    }
  }
  return best === undefined ? undefined : { from: best.from, to: best.to, bookedAt: best.bookedAt };
}

export interface BuildProfileInput {
  userId: string;
  memories: readonly MemoryRow[];
  deletions: readonly MemoryDeletionRow[];
  tickets: readonly TicketRow[];
  /** Whether the airline serves this city (A-02 §4.3 `home_city_served`). Supplied by hands (flight-core); not decided here. */
  isCityServed: (cityName: string) => boolean;
}

export function buildProfile(input: BuildProfileInput): ProfileSnapshot {
  const prefs = recallPreferences(input.userId, input.memories, input.deletions);
  const tickets = input.tickets.filter((t) => t.userId === input.userId);
  const snap: ProfileSnapshot = {
    frequentRoutes: deriveFrequentRoutes(tickets),
    ticketCount: tickets.length,
  };
  const home = prefs.home_city;
  if (home) snap.homeCity = { city: home.value, served: input.isCityServed(home.value) };
  const lang = prefs.preferred_language?.value;
  // An out-of-enum language value counts as "no preference" (never falls back to an older row).
  if (lang === 'zh' || lang === 'en') snap.preferredLanguage = lang;
  const last = deriveLastTicket(tickets);
  if (last) snap.lastTicket = last;
  return snap;
}

/** Convenience wrapper: reads through the injected store, then builds the profile. */
export async function loadProfile(
  store: MemoryStore,
  userId: string,
  isCityServed: (cityName: string) => boolean,
): Promise<ProfileSnapshot> {
  const [memories, deletions, tickets] = await Promise.all([
    store.listMemories(userId),
    store.listDeletions(userId),
    store.listTickets(userId),
  ]);
  return buildProfile({ userId, memories, deletions, tickets, isCityServed });
}
