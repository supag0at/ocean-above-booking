// Acceptance 8 / CT-09 (A-01 §4.5 T06 test): every internal event type with every field filled in; the public view
// never contains messageJson, thinking, system text, toolResult data, profile, offending, guard, usage, fence or
// the compaction summary; assistant-with-tool-calls is always kind:'process' with text only in processText.
import { EmitEventRequest, EphemeralEnvelope, EVENT_TYPES } from '@fb/contracts/server';
import { PublicEphemeralSchema, PublicEventSchema } from '@fb/contracts/web';
import { describe, expect, it } from 'vitest';
import { check } from '../src/validate.ts';
import { displayStatus, toPublicEphemeral, toPublicEvent, type EventRow } from '../src/views.ts';

const RUN = 'run_0123456789ABCDEFGHJKMNPQRS';
const Q = 'q_0123456789ABCDEFGHJKMNPQRS';
const T = 't_0123456789ABCDEFGHJKMNPQRS';
const SECRET = 'LEAK_MARKER';
const piJson = JSON.stringify({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: `${SECRET} thinking` },
    { type: 'text', text: 'x' },
  ],
});
const base = { runId: RUN, attempt: 1, n: 3, messageJson: piJson, piVersion: '1.5.2' };

const samples: Record<string, Record<string, unknown>[]> = {
  'user.message': [{ text: 'hi <b>', clientMessageId: '6f1c9e64-7d0d-4bb5-9e3d-1c2b3a4d5e6f' }],
  'agent.message': [
    { ...base, role: 'system', messageKey: 'm:s', toolsAdded: [SECRET], systemPrompt: `${SECRET} prompt` },
    {
      ...base,
      role: 'assistant',
      messageKey: 'm:p',
      hasToolCalls: true,
      viewText: '',
      processText: 'checking 1234 km',
    },
    {
      ...base,
      role: 'assistant',
      messageKey: 'm:r',
      hasToolCalls: false,
      viewText: 'final reply',
      meta: { template: 'llm_unavailable', ending: { kind: 'failed', code: 'LLM_ERROR', retryable: true } },
      thinking: `${SECRET}`,
    },
    {
      ...base,
      role: 'toolResult',
      messageKey: 'tr:x',
      toolCallId: 'tc1',
      toolName: 'search_routes',
      isError: false,
      data: { secret: SECRET },
      fill: 'replayed',
    },
  ],
  'agent.run_started': [
    {
      runId: RUN,
      inputSeqs: [1],
      consumedUpToSeq: 1,
      lang: 'en',
      today: '2026-11-19',
      profile: { frequentRoutes: [{ from: SECRET, to: 'B', count: 2 }], ticketCount: 3 },
      model: SECRET,
      promptVersion: SECRET,
      projectorVersion: 'p',
      piVersion: 'v',
    },
  ],
  'agent.run_resumed': [{ runId: RUN, attempt: 2 }],
  'agent.run_completed': [
    {
      runId: RUN,
      endReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 9, requests: 1, costUsd: 0.1 },
    },
  ],
  'agent.run_failed': [{ runId: RUN, code: 'LLM_ERROR', retryable: true }],
  'agent.guard_violation': [
    { runId: RUN, attempt: 1, n: 2, messageKey: 'm:g', guard: 'number', offending: [SECRET], action: 'regenerate' },
  ],
  'agent.context_compacted': [
    {
      compactionId: 'cmp_x',
      boundaryRunId: RUN,
      summaryText: `${SECRET} summary`,
      summaryVersion: 1,
      estBefore: 9,
      estAfter: 3,
    },
  ],
  'quote.offered': [{ runId: RUN, quoteId: Q, toolCallId: 'tc1' }],
  'booking.confirmed': [
    {
      quoteId: Q,
      ticketId: T,
      ticketNo: 'OA-HJKMNPQRS',
      summary: {
        ticketNo: SECRET,
        from: 'A',
        to: 'B',
        legs: [],
        transferCities: [],
        display: { legs: [], totalDistanceKm: '1', priceUsd: '2' },
      },
    },
  ],
  'booking.failed': [{ quoteId: Q, code: 'QUOTE_NOT_OFFERED' }],
  'some.future_type': [{ secret: SECRET }],
};

let seq = 0;
const row = (type: string, payload: unknown): EventRow => ({
  seq: ++seq,
  id: '00000000-0000-4000-8000-000000000000',
  sessionId: '00000000-0000-4000-8000-000000000001',
  type,
  actor: type.startsWith('user') ? 'user' : type.startsWith('booking') ? 'system' : 'agent',
  ts: '2026-11-19T00:00:00.000Z',
  traceId: SECRET,
  idempotencyKey: SECRET,
  payload,
});

describe('toPublicEvent (CT-09)', () => {
  it('covers every durable type of the contract', () => {
    for (const t of EVENT_TYPES) expect(samples[t], t).toBeDefined();
  });

  const all = Object.entries(samples).flatMap(([type, ps]) =>
    ps.map((p) => ({ type, view: toPublicEvent(row(type, p)) })),
  );

  it('matches the public schema and never leaks internal fields', () => {
    for (const { type, view } of all) {
      expect(check(PublicEventSchema, view), `${type}: ${JSON.stringify(view)}`).toBe(true);
      const s = JSON.stringify(view);
      expect(s, type).not.toContain('messageJson');
      expect(s, type).not.toContain(SECRET);
      expect(s, type).not.toMatch(/thinking|offending|usage|profile|summary|fence|"data"|idempotency|traceId/);
    }
  });

  it('snapshot', () => {
    expect(all.map((a) => a.view)).toMatchSnapshot();
  });

  it('assistant with tool calls is kind:process, text only in processText', () => {
    const v = toPublicEvent(row('agent.message', samples['agent.message']![1]));
    expect(v.payload).toEqual({ runId: RUN, messageKey: 'm:p', kind: 'process', processText: 'checking 1234 km' });
    expect(v.payload).not.toHaveProperty('text');
    // even if a buggy writer put text in viewText, it never surfaces as a reply
    const w = toPublicEvent(row('agent.message', { ...samples['agent.message']![1], viewText: 'oops' }));
    expect(JSON.stringify(w)).not.toContain('oops');
  });

  it('system message, compaction and unknown types are hidden with only the seq', () => {
    for (const p of [
      row('agent.message', samples['agent.message']![0]),
      row('agent.context_compacted', samples['agent.context_compacted']![0]),
      row('x.y', {}),
    ]) {
      const v = toPublicEvent(p);
      expect(v).toEqual({ seq: p.seq, type: 'hidden', actor: p.actor, ts: p.ts, payload: {} });
    }
  });

  it('all samples except the extra-field ones are valid harness emits (keeps samples honest)', () => {
    const harnessTypes = ['agent.run_resumed', 'agent.run_failed', 'quote.offered', 'agent.context_compacted'];
    for (const t of harnessTypes) {
      expect(check(EmitEventRequest, { type: t, payload: samples[t]![0], idempotencyKey: 'k' }), t).toBe(true);
    }
  });
});

describe('toPublicEphemeral', () => {
  it('drops fence / sessionId / traceId and matches the public schema', () => {
    const env = {
      sessionId: '00000000-0000-4000-8000-000000000001',
      type: 'agent.tool_status',
      ts: '2026-11-19T00:00:00.000Z',
      traceId: 't',
      fence: 7,
      payload: { runId: RUN, toolCallId: 'tc', name: 'search_routes', phase: 'end', isError: false },
    };
    expect(check(EphemeralEnvelope, env)).toBe(true);
    const v = toPublicEphemeral(env.type, env.payload);
    expect(v).toEqual({ type: 'agent.tool_status', payload: env.payload });
    expect(check(PublicEphemeralSchema, v)).toBe(true);
    for (const p of [
      { runId: RUN, messageKey: 'm', textDelta: 'a' },
      { runId: RUN, messageKey: 'm', reset: true },
    ]) {
      expect(check(PublicEphemeralSchema, toPublicEphemeral('agent.delta', p))).toBe(true);
    }
    expect(toPublicEphemeral('agent.status', {})).toBeNull();
  });
});

describe('displayStatus (A-01 §6.4)', () => {
  it('follows the table order', () => {
    const b = { openRunId: null, lastUserSeq: 0, consumedUpToSeq: 0, lastRunOutcome: null };
    expect(displayStatus({ ...b, openRunId: 'r', lastUserSeq: 5 })).toBe('running');
    expect(displayStatus({ ...b, lastUserSeq: 2, consumedUpToSeq: 1, lastRunOutcome: 'failed' })).toBe('queued');
    expect(displayStatus({ ...b, lastRunOutcome: 'failed' })).toBe('error');
    expect(displayStatus(b)).toBe('idle');
  });
});

describe('validate.check', () => {
  it('is strict: extra keys, wrong types, integers, patterns, unknown keywords', () => {
    const s = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    };
    expect(check(s, { a: 1 })).toBe(true);
    expect(check(s, { a: 1.5 })).toBe(false);
    expect(check(s, { a: '1' })).toBe(false);
    expect(check(s, { a: 1, userId: 'x' })).toBe(false);
    expect(check(s, {})).toBe(false);
    expect(check({ type: 'string', pattern: '^q_' }, 'q_1')).toBe(true);
    expect(check({ type: 'string', pattern: '^q_' }, 'x')).toBe(false);
    expect(check({ type: 'string', format: 'uuid' }, 'x')).toBe(false); // unknown keyword: fail closed
  });
});
