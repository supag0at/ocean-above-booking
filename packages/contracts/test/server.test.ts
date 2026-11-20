import { describe, expect, it } from 'vitest';
import Value from 'typebox/value';
import * as server from '../src/server/index.ts';
import * as flight from '../src/flight/index.ts';
import {
  AgentMessagePayload,
  ApiError,
  CROCKFORD_ALPHABET,
  CreateBookingRequest,
  EVENT_TYPES,
  EVENT_WRITE_POLICY,
  EPHEMERAL_TYPES,
  EmitEventRequest,
  EphemeralEnvelope,
  EventEnvelope,
  LOCATIONS_DB_SHA256,
  AgentRunFailedPayload,
  BookingConfirmedPayload,
  BookingFailedPayload,
  ID_PREFIX,
  QuoteOfferedPayload,
  WRITERS,
  assistantMessageKey,
  canWrite,
  canonicalJson,
  compactIdempotencyKey,
  compactionId,
  newId,
  newQuoteId,
  newRunId,
  newTicketId,
  offerIdempotencyKey,
  requiresFence,
  runDoneIdempotencyKey,
  sweeperWakeJobId,
  ticketNoFromId,
  toolResultIdempotencyKey,
  toolResultMessageKey,
  traceIdFromTraceparent,
  wakeJobId,
  writableTypes,
} from '../src/server/index.ts';

const SID = '123e4567-e89b-12d3-a456-426614174000';
const EID = '223e4567-e89b-12d3-a456-426614174001';
const RUN = newRunId();
const QID = newQuoteId();
const TID = newTicketId();
const TS = '2026-11-19T10:00:00.000Z';

const base = { id: EID, sessionId: SID, seq: 3, ts: TS, traceId: 'abc', schemaVersion: 1 as const };

const validAgentMessage = {
  runId: RUN,
  attempt: 1,
  n: 0,
  messageKey: assistantMessageKey(RUN, 1, 0),
  role: 'assistant',
  messageJson: '{"role":"assistant"}',
  piVersion: '1.5.2',
  viewText: '',
  hasToolCalls: true,
  processText: 'checking the route',
};

describe('EventEnvelope', () => {
  const ok = {
    ...base,
    type: 'agent.message',
    actor: 'agent',
    idempotencyKey: 'msg:x',
    payload: validAgentMessage,
  };
  it('accepts a valid envelope', () => {
    expect(Value.Check(EventEnvelope, ok)).toBe(true);
  });
  it('rejects extra envelope field', () => {
    expect(Value.Check(EventEnvelope, { ...ok, fence: 1 })).toBe(false);
  });
  it('rejects wrong type', () => {
    expect(Value.Check(EventEnvelope, { ...ok, seq: '3' })).toBe(false);
  });
  it('rejects an actor that does not belong to the type', () => {
    expect(Value.Check(EventEnvelope, { ...ok, actor: 'user' })).toBe(false);
  });
  it('rejects a payload that belongs to another type', () => {
    expect(Value.Check(EventEnvelope, { ...ok, type: 'quote.offered' })).toBe(false);
  });
});

describe('agent.message payload (M-2/M-3/M-16)', () => {
  const common = {
    runId: RUN,
    attempt: 1,
    n: 0,
    messageKey: assistantMessageKey(RUN, 1, 0),
    messageJson: '{"role":"x"}',
    piVersion: '1.5.2',
  };
  const system = { ...common, role: 'system' };
  const toolCalls = { ...common, role: 'assistant', hasToolCalls: true, viewText: '', processText: 'checking' };
  const final = { ...common, role: 'assistant', hasToolCalls: false, viewText: 'Hello' };
  const toolResult = { ...common, role: 'toolResult', toolCallId: 'c1', toolName: 'quote_route', isError: false };
  const ok = (p: unknown) => Value.Check(AgentMessagePayload, p);
  const without = (o: Record<string, unknown>, k: string) =>
    Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

  it('system: valid / rejects assistant-only and toolResult-only fields', () => {
    expect(ok(system)).toBe(true);
    expect(ok({ ...system, viewText: 'x' })).toBe(false);
    expect(ok({ ...system, hasToolCalls: false })).toBe(false);
    expect(ok({ ...system, processText: 'x' })).toBe(false);
    expect(ok({ ...system, toolCallId: 'c1' })).toBe(false);
  });
  it('assistant with tool calls: valid (processText may be empty)', () => {
    expect(ok(toolCalls)).toBe(true);
    expect(ok({ ...toolCalls, processText: '' })).toBe(true);
  });
  it('assistant with tool calls: invalid combinations', () => {
    expect(ok({ ...toolCalls, viewText: 'visible' })).toBe(false); // viewText must be the literal ""
    expect(ok(without(toolCalls, 'viewText'))).toBe(false); // viewText is mandatory
    expect(ok(without(toolCalls, 'processText'))).toBe(false); // processText is mandatory
    expect(ok({ ...toolCalls, processText: 5 })).toBe(false);
    expect(
      ok({ ...toolCalls, meta: { template: 'turn_limit', ending: { kind: 'completed', endReason: 'stop' } } }),
    ).toBe(false);
    expect(ok({ ...toolCalls, toolCallId: 'c1' })).toBe(false);
  });
  it('assistant without tool calls: valid, with and without meta', () => {
    expect(ok(final)).toBe(true);
    expect(ok({ ...final, viewText: '' })).toBe(true);
    expect(
      ok({ ...final, meta: { template: 'turn_limit', ending: { kind: 'completed', endReason: 'turn_limit' } } }),
    ).toBe(true);
    expect(
      ok({
        ...final,
        meta: { template: 'llm_unavailable', ending: { kind: 'failed', code: 'LLM_ERROR', retryable: true } },
      }),
    ).toBe(true);
  });
  it('assistant without tool calls: invalid combinations', () => {
    expect(ok(without(final, 'viewText'))).toBe(false); // viewText mandatory
    expect(ok({ ...final, processText: 'x' })).toBe(false); // processText forbidden
    expect(ok({ ...final, viewText: 5 })).toBe(false);
    expect(ok(without(final, 'hasToolCalls'))).toBe(false); // hasToolCalls mandatory for assistant (A2-12)
    expect(ok({ ...final, meta: { template: 'nope', ending: { kind: 'completed', endReason: 'stop' } } })).toBe(false);
    expect(ok({ ...final, isError: false })).toBe(false);
  });
  it('toolResult: valid, with data / fill', () => {
    expect(ok(toolResult)).toBe(true);
    expect(ok({ ...toolResult, isError: true, data: { a: 1 }, fill: 'interrupted' })).toBe(true);
    expect(ok({ ...toolResult, fill: 'replayed' })).toBe(true);
  });
  it('toolResult: each required field is required, and assistant-only fields are rejected', () => {
    for (const k of ['toolCallId', 'toolName', 'isError']) expect(ok(without(toolResult, k))).toBe(false);
    expect(ok({ ...toolResult, isError: 'no' })).toBe(false);
    expect(ok({ ...toolResult, viewText: 'x' })).toBe(false);
    expect(ok({ ...toolResult, hasToolCalls: false })).toBe(false);
    expect(ok({ ...toolResult, processText: 'x' })).toBe(false);
    expect(ok({ ...toolResult, fill: 'other' })).toBe(false);
  });
  it('rejects extra field, unknown role and malformed run id', () => {
    expect(ok({ ...toolCalls, thinking: 'x' })).toBe(false);
    expect(ok({ ...toolCalls, role: 'user' })).toBe(false);
    expect(ok({ ...toolCalls, runId: 'run_x' })).toBe(false);
  });
});

describe('M-12 ErrorCode single source', () => {
  const failed = { runId: RUN, retryable: false };
  it('run_failed / booking.failed accept agent-side codes and reject unknown ones', () => {
    expect(Value.Check(AgentRunFailedPayload, { ...failed, code: 'RUN_TIMEOUT' })).toBe(true);
    expect(Value.Check(AgentRunFailedPayload, { ...failed, code: 'INTERNAL' })).toBe(true);
    expect(Value.Check(AgentRunFailedPayload, { ...failed, code: 'NOPE' })).toBe(false);
    expect(Value.Check(BookingFailedPayload, { quoteId: QID, code: 'BOOKING_UNAVAILABLE' })).toBe(true);
    expect(Value.Check(BookingFailedPayload, { quoteId: QID, code: 'NOPE' })).toBe(false);
  });
  it('booking.confirmed summary is web TicketSummary', () => {
    const summary = {
      ticketNo: 'OA-JKMNPQRS',
      from: 'A',
      to: 'C',
      legs: [{ from: 'A', to: 'B' }],
      transferCities: ['B'],
      display: { legs: ['1.00'], totalDistanceKm: '1.00', priceUsd: '0.13' },
    };
    const p = { quoteId: QID, ticketId: TID, ticketNo: summary.ticketNo, summary };
    expect(Value.Check(BookingConfirmedPayload, p)).toBe(true);
    expect(Value.Check(BookingConfirmedPayload, { ...p, summary: { ...summary, priceCents: 13 } })).toBe(false);
  });
});

describe('M-17 ephemeral fence', () => {
  const internal = {
    sessionId: SID,
    type: 'agent.tool_status',
    ts: TS,
    traceId: 't',
    payload: { runId: RUN, toolCallId: 'c', name: 'quote_route', phase: 'start' },
  };
  it('internal envelope requires fence', () => {
    expect(Value.Check(EphemeralEnvelope, { ...internal, fence: 1 })).toBe(true);
    expect(Value.Check(EphemeralEnvelope, internal)).toBe(false);
    expect(Value.Check(EphemeralEnvelope, { ...internal, fence: -1 })).toBe(false);
  });
});

describe('M-18 / M-19 server entry', () => {
  it('re-exports LOCATIONS_DB_SHA256 from flight (same value)', () => {
    expect(LOCATIONS_DB_SHA256).toBe(flight.LOCATIONS_DB_SHA256);
  });
  it('M-24: memory ids are DB uuids, no m_ prefix', () => {
    expect('memory' in ID_PREFIX).toBe(false);
  });
});

describe('quote.offered payload', () => {
  const ok = { runId: RUN, quoteId: QID, toolCallId: 'call_1' };
  it('valid', () => expect(Value.Check(QuoteOfferedPayload, ok)).toBe(true));
  it('rejects extra number field', () =>
    expect(Value.Check(QuoteOfferedPayload, { ...ok, priceCents: 1 })).toBe(false));
  it('rejects malformed quoteId', () =>
    expect(Value.Check(QuoteOfferedPayload, { ...ok, quoteId: 'q_abc' })).toBe(false));
});

describe('every durable type has a payload schema and a policy', () => {
  it('policy rows match the types', () => {
    for (const t of [...EVENT_TYPES, ...EPHEMERAL_TYPES]) expect(EVENT_WRITE_POLICY).toHaveProperty(t);
    expect(Object.keys(EVENT_WRITE_POLICY).length).toBe(EVENT_TYPES.length + EPHEMERAL_TYPES.length);
  });
});

describe('ephemeral envelope', () => {
  const ok = {
    sessionId: SID,
    type: 'agent.reasoning_delta',
    ts: TS,
    traceId: 't',
    fence: 4,
    payload: { runId: RUN, messageKey: 'm:a:1:0', textDelta: 'hi' },
  };
  it('valid', () => expect(Value.Check(EphemeralEnvelope, ok)).toBe(true));
  it('rejects extra payload field', () => {
    expect(Value.Check(EphemeralEnvelope, { ...ok, payload: { ...ok.payload, masked: true } })).toBe(false);
  });
  it('rejects wrong type', () => {
    expect(Value.Check(EphemeralEnvelope, { ...ok, fence: 'x' })).toBe(false);
  });
  it('rejects reasoning_delta over 4096 chars', () => {
    expect(Value.Check(EphemeralEnvelope, { ...ok, payload: { ...ok.payload, textDelta: 'a'.repeat(4097) } })).toBe(
      false,
    );
  });
});

describe('session API', () => {
  const ok = {
    type: 'quote.offered',
    payload: { runId: RUN, quoteId: QID, toolCallId: 'c1' },
    idempotencyKey: offerIdempotencyKey(RUN, 'c1'),
  };
  it('emit request: valid', () => expect(Value.Check(EmitEventRequest, ok)).toBe(true));
  it('emit request: extra field (actor) rejected', () => {
    expect(Value.Check(EmitEventRequest, { ...ok, actor: 'user' })).toBe(false);
  });
  it('emit request: wrong type rejected', () => {
    expect(Value.Check(EmitEventRequest, { ...ok, idempotencyKey: 5 })).toBe(false);
  });
  it('emit request: harness cannot emit user.message or booking.confirmed', () => {
    expect(
      Value.Check(EmitEventRequest, {
        type: 'user.message',
        payload: { text: 'x', clientMessageId: 'c' },
        idempotencyKey: 'user:c',
      }),
    ).toBe(false);
    expect(Value.Check(EmitEventRequest, { ...ok, type: 'booking.confirmed' })).toBe(false);
  });
});

describe('booking + hands + error envelope', () => {
  it('booking request valid / extra / wrong type', () => {
    const ok = { quoteId: QID, userId: SID, requestId: 'r1' };
    expect(Value.Check(CreateBookingRequest, ok)).toBe(true);
    expect(Value.Check(CreateBookingRequest, { ...ok, sessionId: SID })).toBe(false);
    expect(Value.Check(CreateBookingRequest, { ...ok, userId: 5 })).toBe(false);
  });
  it('M-12: the execute envelope is not defined in server (tools owns it)', () => {
    expect('HandsExecuteRequest' in server).toBe(false);
    expect('HandsExecuteResponse' in server).toBe(false);
    expect('QuoteSnapshot' in server).toBe(false);
    expect('TicketRecord' in server).toBe(false);
    expect('ERROR_CODES' in server).toBe(false);
  });
  it('error envelope', () => {
    const ok = { error: { code: 'FENCE_STALE', message: 'm', traceId: 't' } };
    expect(Value.Check(ApiError, ok)).toBe(true);
    expect(Value.Check(ApiError, { error: { ...ok.error, extra: 1 } })).toBe(false);
    expect(Value.Check(ApiError, { error: { ...ok.error, code: 1 } })).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ a: 1, b: 2, c: 3 })).toBe(canonicalJson({ c: 3, a: 1, b: 2 }));
  });
  it('sorts recursively, no whitespace, arrays keep order', () => {
    expect(canonicalJson({ z: [3, { y: 1, x: [2, 1] }], a: { d: null, c: 'x y' } })).toBe(
      '{"a":{"c":"x y","d":null},"z":[3,{"x":[2,1],"y":1}]}',
    );
  });
  it('handles scalars', () => {
    expect(canonicalJson('é"')).toBe('"é\\""');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(1.5)).toBe('1.5');
  });
  it('is stable across a JSON round trip with shuffled keys (jsonb behaviour)', () => {
    const v = { b: [1, { y: 1, x: 2 }], a: 'q' };
    expect(canonicalJson(JSON.parse('{"a":"q","b":[1,{"x":2,"y":1}]}'))).toBe(canonicalJson(v));
  });
  it('throws on non-canonicalizable values', () => {
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson(10n)).toThrow();
    expect(() => canonicalJson(Symbol('s'))).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
    expect(() => canonicalJson(new Map())).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow();
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 2])).toThrow();
  });
  it('allows a shared (non-circular) reference twice', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('newId', () => {
  it('has prefix + 26 Crockford chars', () => {
    for (const p of Object.values(ID_PREFIX)) {
      const id = newId(p);
      expect(id.startsWith(p)).toBe(true);
      const body = id.slice(p.length);
      expect(body).toHaveLength(26);
      for (const ch of body) expect(CROCKFORD_ALPHABET).toContain(ch);
    }
    expect(newQuoteId()).toMatch(/^q_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newTicketId()).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newRunId()).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it('generates 1000 distinct ids', () => {
    expect(new Set(Array.from({ length: 1000 }, () => newId('q_'))).size).toBe(1000);
  });
  it('rejects a bad prefix', () => {
    expect(() => newId('Q')).toThrow();
    expect(() => newId('')).toThrow();
  });
  it('derives ticketNo from the last 8 chars', () => {
    expect(ticketNoFromId(TID)).toBe(`OA-${TID.slice(-8)}`);
    expect(() => ticketNoFromId('x')).toThrow();
  });
});

describe('keys', () => {
  it('wake job ids (M-7)', () => {
    expect(wakeJobId('s1', 7)).toBe('wake-s1-7');
    expect(sweeperWakeJobId('s1', 15_000 * 10 + 14_999)).toBe('wake-s1-scan-10');
    expect(sweeperWakeJobId('s1', 15_000 * 11)).toBe('wake-s1-scan-11');
    expect(() => wakeJobId('s1', 0)).toThrow();
    expect(wakeJobId('s1', 1)).not.toContain(':');
  });
  it('idempotency and message keys (M-6, A-02 §3.7)', () => {
    expect(offerIdempotencyKey('run_a', 'c1')).toBe('offer:run_a:c1');
    expect(toolResultMessageKey('run_a', 'c1')).toBe('tr:run_a:c1');
    expect(toolResultIdempotencyKey('run_a', 'c1')).toBe('msg:tr:run_a:c1');
    expect(assistantMessageKey('run_a', 2, 5)).toBe('m:run_a:2:5');
    expect(runDoneIdempotencyKey('run_a')).toBe('run:run_a:done');
    expect(compactIdempotencyKey(compactionId('run_a'))).toBe('compact:cmp_run_a');
  });
  it('X-Trace-Id from traceparent (M-9)', () => {
    expect(traceIdFromTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
    expect(traceIdFromTraceparent('garbage')).toBeNull();
    expect(traceIdFromTraceparent(`00-${'0'.repeat(32)}-b7ad6b7169203331-01`)).toBeNull();
  });
});

describe('write whitelist (CT-11)', () => {
  it('harness cannot write user or system events', () => {
    expect(canWrite('harness', 'user.message')).toBe(false);
    expect(canWrite('harness', 'booking.confirmed')).toBe(false);
    expect(canWrite('harness', 'booking.failed')).toBe(false);
  });
  it('harness writes exactly the A-01 §5.1 step 3 list', () => {
    const durable = writableTypes('harness').filter((t) => EVENT_WRITE_POLICY[t].kind === 'durable');
    expect([...durable].sort()).toEqual(
      [
        'agent.run_started',
        'agent.run_resumed',
        'agent.message',
        'quote.offered',
        'agent.guard_violation',
        'agent.run_completed',
        'agent.run_failed',
        'agent.context_compacted',
      ].sort(),
    );
  });
  it('booking.confirmed has a single writer: gateway (spec A-01 §5.2; booking service has no event grant)', () => {
    expect(WRITERS.filter((w) => canWrite(w, 'booking.confirmed'))).toEqual(['gateway']);
    expect(canWrite('booking', 'booking.confirmed')).toBe(false);
  });
  it('user.message only from gateway; hands writes no events', () => {
    expect(WRITERS.filter((w) => canWrite(w, 'user.message'))).toEqual(['gateway']);
    expect(writableTypes('hands')).toEqual([]);
    expect(writableTypes('booking')).toEqual([]);
  });
  it('unknown / prototype names are never writable', () => {
    for (const w of WRITERS) {
      expect(canWrite(w, 'session.created')).toBe(false);
      expect(canWrite(w, 'toString')).toBe(false);
      expect(canWrite(w, '__proto__')).toBe(false);
    }
  });
  it('every harness write carries a fence; gateway writes do not', () => {
    for (const t of [...EVENT_TYPES, ...EPHEMERAL_TYPES]) {
      expect(requiresFence(t)).toBe(EVENT_WRITE_POLICY[t].writer === 'harness');
    }
    expect(requiresFence('agent.context_compacted')).toBe(true);
  });
});
