// computeWork (A-02 §3.3): pure function over the event log.
import { ofType, type Ev } from './events.ts';

export type Work =
  | { readonly kind: 'none' }
  | { readonly kind: 'start'; readonly inputSeqs: readonly number[] }
  | { readonly kind: 'resume'; readonly runId: string };

export function computeWork(events: readonly Ev[]): Work {
  const consumed = new Set<number>();
  for (const s of ofType(events, 'agent.run_started')) for (const q of s.payload.inputSeqs) consumed.add(q);

  const openRun = findOpenRun(events);
  // An open run is resumed first; inputs that arrived meanwhile wait for the next run (§3.3).
  if (openRun !== undefined) return { kind: 'resume', runId: openRun };

  const pending = ofType(events, 'user.message')
    .map((e) => e.seq)
    .filter((s) => !consumed.has(s))
    .sort((a, b) => a - b);
  // Seam invariant A2-4: a new run consumes ALL pending inputs, ascending.
  if (pending.length > 0) return { kind: 'start', inputSeqs: pending };
  return { kind: 'none' };
}

/** runId of the last run_started that has no run_completed / run_failed with the same runId. */
export function findOpenRun(events: readonly Ev[]): string | undefined {
  const starts = ofType(events, 'agent.run_started');
  const last = starts[starts.length - 1];
  if (last === undefined) return undefined;
  const runId = last.payload.runId;
  const done = events.some(
    (e) => (e.type === 'agent.run_completed' || e.type === 'agent.run_failed') && e.payload.runId === runId,
  );
  return done ? undefined : runId;
}
