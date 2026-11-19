// Event write whitelist (A-01 §5.1 step 3, §6.2, §6.3; A-02 §2; CT-11).
// One row per event type: who may write it, whether a lease fence is mandatory, durable vs ephemeral.
import type { EphemeralType, EventType } from './events.ts';

export type Writer = 'gateway' | 'harness' | 'booking' | 'hands';
export const WRITERS: readonly Writer[] = ['gateway', 'harness', 'booking', 'hands'];
export type AnyEventType = EventType | EphemeralType;

export interface EventPolicy {
  readonly writer: Writer;
  /** Must the write carry a valid lease fence (A-01 §5.1 step 4 applies to every harness write, no exceptions). */
  readonly fence: boolean;
  /** durable = persisted in app.events via the session API / gateway; ephemeral = Redis pubsub -> SSE only. */
  readonly kind: 'durable' | 'ephemeral';
}

// TODO(T01-REVIEW): the task brief expects "only booking can write booking.confirmed", but the spec says the
// *gateway* writes it as the system actor after calling booking (A-01 §5.2 step 3, §6.3; A-01 §3.3: only gateway
// writes events; booking has no events grant). Following the spec: writer = 'gateway'. 'booking' and 'hands'
// are valid Writer values that currently own no event types.
// TODO(T01-REVIEW): ephemeral events are published by harness straight to Redis (A-02 §2.2, A-01 §7.1/§7.2) with a
// fence in the envelope; modelled as writer 'harness', fence true.
export const EVENT_WRITE_POLICY = {
  'user.message': { writer: 'gateway', fence: false, kind: 'durable' },
  'quote.offered': { writer: 'harness', fence: true, kind: 'durable' },
  'booking.confirmed': { writer: 'gateway', fence: false, kind: 'durable' },
  'booking.failed': { writer: 'gateway', fence: false, kind: 'durable' },
  'agent.run_started': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.run_resumed': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.message': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.guard_violation': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.run_completed': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.run_failed': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.context_compacted': { writer: 'harness', fence: true, kind: 'durable' },
  'agent.delta': { writer: 'harness', fence: true, kind: 'ephemeral' },
  'agent.reasoning_delta': { writer: 'harness', fence: true, kind: 'ephemeral' },
  'agent.tool_status': { writer: 'harness', fence: true, kind: 'ephemeral' },
} as const satisfies Record<AnyEventType, EventPolicy>;

export function policyOf(type: string): EventPolicy | undefined {
  return Object.hasOwn(EVENT_WRITE_POLICY, type) ? EVENT_WRITE_POLICY[type as AnyEventType] : undefined;
}

/** True only if `writer` is the one allowed writer of `type`. Unknown types are never writable. */
export function canWrite(writer: Writer, type: string): boolean {
  return policyOf(type)?.writer === writer;
}

/** Does a write of `type` need a fence? Unknown types: false (they are rejected by canWrite anyway). */
export function requiresFence(type: string): boolean {
  return policyOf(type)?.fence === true;
}

export function isEphemeral(type: string): boolean {
  return policyOf(type)?.kind === 'ephemeral';
}

/** Types a writer may write, in table order. */
export function writableTypes(writer: Writer): AnyEventType[] {
  return (Object.keys(EVENT_WRITE_POLICY) as AnyEventType[]).filter((t) => EVENT_WRITE_POLICY[t].writer === writer);
}
