// Typed access to the session event log (A-01 §6.1, A-02 §2). Pure helpers, no IO.
import type { EventEnvelope, EventType, PayloadOf } from '@fb/contracts/server';

export type Ev = EventEnvelope;
export type EvOf<T extends EventType> = Extract<Ev, { type: T }>;

export function isType<T extends EventType>(e: Ev, type: T): e is EvOf<T> {
  return e.type === type;
}

export function ofType<T extends EventType>(events: readonly Ev[], type: T): EvOf<T>[] {
  return events.filter((e): e is EvOf<T> => e.type === type);
}

export type AgentMessagePayload = PayloadOf<'agent.message'>;
export type RunStartedPayload = PayloadOf<'agent.run_started'>;

/** The runId carried by an agent-side event, if any. */
export function runIdOf(e: Ev): string | undefined {
  const p = e.payload as { runId?: unknown };
  return typeof p.runId === 'string' ? p.runId : undefined;
}

export function lastSeq(events: readonly Ev[]): number {
  return events.length === 0 ? 0 : (events[events.length - 1] as Ev).seq;
}

/** Events of one run, in log order. */
export function eventsOfRun(events: readonly Ev[], runId: string): Ev[] {
  return events.filter((e) => runIdOf(e) === runId);
}

export function findRunStarted(events: readonly Ev[], runId: string): EvOf<'agent.run_started'> | undefined {
  return ofType(events, 'agent.run_started').find((e) => e.payload.runId === runId);
}

/** Merge two seq-sorted logs, dropping duplicates by seq. */
export function mergeEvents(a: readonly Ev[], b: readonly Ev[]): Ev[] {
  const bySeq = new Map<number, Ev>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}
