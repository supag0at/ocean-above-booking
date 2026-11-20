// Test stand-in for @fb/memory's buildProfile (T10), written against hands' ProfileBuilder port (A-02 §9.3).
// Recall rule: per key only the newest row (createdAt, then id) counts; a tombstone or a deleted row means the
// key is absent — never fall back to an older value. Derived profile is computed from tickets.
import type { ProfileSnapshot } from '@fb/contracts/server';
import type { MemoryRow, ProfileBuilder } from '../../src/ports.ts';

const newer = (a: MemoryRow, b: MemoryRow) => (a.createdAt === b.createdAt ? a.id > b.id : a.createdAt > b.createdAt);

export const fakeBuildProfile: ProfileBuilder = (input) => {
  const deleted = new Set(input.deletions.filter((d) => d.userId === input.userId).map((d) => d.memoryId));
  const latest = new Map<string, MemoryRow>();
  for (const m of input.memories) {
    if (m.userId !== input.userId) continue;
    const cur = latest.get(m.key);
    if (!cur || newer(m, cur)) latest.set(m.key, m);
  }
  const value = (k: string) => {
    const m = latest.get(k);
    return m && m.value !== null && !deleted.has(m.id) ? m.value : undefined;
  };
  const tickets = input.tickets.filter((t) => t.userId === input.userId);
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const t of tickets) {
    const k = `${t.from}\u0000${t.to}`;
    const c = counts.get(k) ?? { from: t.from, to: t.to, count: 0 };
    c.count++;
    counts.set(k, c);
  }
  const snap: ProfileSnapshot = {
    frequentRoutes: [...counts.values()]
      .sort((a, b) => b.count - a.count || (a.from + a.to < b.from + b.to ? -1 : 1))
      .slice(0, 3),
    ticketCount: tickets.length,
  };
  const home = value('home_city');
  if (home !== undefined) snap.homeCity = { city: home, served: input.isCityServed(home) };
  const lang = value('preferred_language');
  if (lang === 'zh' || lang === 'en') snap.preferredLanguage = lang;
  const last = [...tickets].sort((a, b) => (a.bookedAt < b.bookedAt ? 1 : -1))[0];
  if (last) snap.lastTicket = { from: last.from, to: last.to, bookedAt: last.bookedAt };
  return snap;
};
