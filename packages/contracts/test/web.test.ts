import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import * as web from '../src/web/index.ts';

const quote = {
  quoteId: 'q_01',
  from: 'Shanghai',
  to: 'Dubai',
  legs: [{ from: 'Shanghai', to: 'Dubai', distanceKm: 5800.123 }],
  transferCities: [],
  totalDistanceKm: 5800.123,
  priceCents: 75402,
  display: { legs: ['5800.12'], totalDistanceKm: '5800.12', priceUsd: '754.02' },
  dataSha256: 'f'.repeat(64),
  createdAt: '2026-11-19T00:00:00Z',
};
const user = { id: 'u1', username: 'bob', locale: 'zh' };
const session = {
  id: 's1',
  title: null,
  locale: 'en',
  status: 'idle',
  lastSeq: 3,
  createdAt: '2026-11-19T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
};
const ticket = {
  ticketId: 't1',
  ticketNo: 'FB-1',
  sessionId: 's1',
  quoteId: 'q_01',
  from: 'Shanghai',
  to: 'Dubai',
  itinerary: quote,
  priceCents: 75402,
  bookedAt: '2026-11-19T00:00:00Z',
};
const memory = {
  memoryId: 'm1',
  key: 'home_city',
  value: 'Shanghai',
  createdAt: '2026-11-19T00:00:00Z',
  source: { sessionId: 's1', seq: 1 },
};
const env = { seq: 1, actor: 'agent', ts: '2026-11-19T00:00:00Z' };
const uuid = '123e4567-e89b-12d3-a456-426614174000';

type Case = { name: string; schema: TSchema; ok: unknown; wrongType: unknown };
const cases: Case[] = [
  {
    name: 'ApiError',
    schema: web.ApiErrorSchema,
    ok: { error: { code: 'INTERNAL', message: 'x', traceId: 't' } },
    wrongType: { error: { code: 'NOPE', message: 'x', traceId: 't' } },
  },
  { name: 'LoginBody', schema: web.LoginBodySchema, ok: { username: 'bob' }, wrongType: { username: 5 } },
  {
    name: 'UserResponse',
    schema: web.UserResponseSchema,
    ok: { user },
    wrongType: { user: { ...user, locale: 'fr' } },
  },
  { name: 'PatchMeBody', schema: web.PatchMeBodySchema, ok: { locale: 'en' }, wrongType: { locale: 1 } },
  { name: 'PageQuery', schema: web.PageQuerySchema, ok: { cursor: 'abc_-', limit: '20' }, wrongType: { limit: 20 } },
  {
    name: 'SessionsPage',
    schema: web.SessionsPageSchema,
    ok: { items: [session] },
    wrongType: { items: [{ ...session, lastSeq: '3' }] },
  },
  { name: 'CreateSessionBody', schema: web.CreateSessionBodySchema, ok: {}, wrongType: { locale: 'xx' } },
  {
    name: 'SessionResponse',
    schema: web.SessionResponseSchema,
    ok: { session },
    wrongType: { session: { ...session, status: 'busy' } },
  },
  {
    name: 'EventsQuery',
    schema: web.EventsQuerySchema,
    ok: { afterSeq: '0', limit: '50' },
    wrongType: { afterSeq: 0 },
  },
  {
    name: 'EventsResponse',
    schema: web.EventsResponseSchema,
    ok: { events: [{ ...env, type: 'quote.offered', payload: { quoteId: 'q' } }], hasMore: false },
    wrongType: { events: [], hasMore: 'no' },
  },
  {
    name: 'PostMessageBody',
    schema: web.PostMessageBodySchema,
    ok: { text: 'hi', clientMessageId: uuid },
    wrongType: { text: 'hi', clientMessageId: 'not-a-uuid' },
  },
  {
    name: 'PostMessageResponse',
    schema: web.PostMessageResponseSchema,
    ok: { event: { ...env, actor: 'user', type: 'user.message', payload: { text: 'hi', clientMessageId: uuid } } },
    wrongType: { event: 1 },
  },
  {
    name: 'QuoteResponse',
    schema: web.QuoteResponseSchema,
    ok: { quote: { sessionId: 's1', quote, booking: { status: 'available' } } },
    wrongType: { quote: { sessionId: 's1', quote, booking: { status: 'booked' } } },
  },
  {
    name: 'ConfirmCreatedResponse',
    schema: web.ConfirmCreatedResponseSchema,
    ok: { ticket },
    wrongType: { ticket: { ...ticket, priceCents: 1.5 } },
  },
  {
    name: 'ConfirmReplayResponse',
    schema: web.ConfirmReplayResponseSchema,
    ok: { ticket, alreadyBooked: true },
    wrongType: { ticket, alreadyBooked: false },
  },
  {
    name: 'TicketsPage',
    schema: web.TicketsPageSchema,
    ok: { items: [ticket], nextCursor: 'c' },
    wrongType: { items: ticket },
  },
  {
    name: 'ProfileResponse',
    schema: web.ProfileResponseSchema,
    ok: { preferences: [memory] },
    wrongType: { preferences: [{ ...memory, key: 'other' }] },
  },
  { name: 'HealthResponse', schema: web.HealthResponseSchema, ok: { ok: true }, wrongType: { ok: 'yes' } },
  { name: 'StatusFrame', schema: web.StatusFrameSchema, ok: { status: 'running' }, wrongType: { status: 'x' } },
  {
    name: 'PublicEphemeral(delta)',
    schema: web.PublicEphemeralSchema,
    ok: { type: 'agent.delta', payload: { runId: 'r', messageKey: 'k', textDelta: 'a' } },
    wrongType: { type: 'agent.delta', payload: { runId: 'r', messageKey: 'k', textDelta: 1 } },
  },
  {
    name: 'PublicEphemeral(reset)',
    schema: web.PublicEphemeralSchema,
    ok: { type: 'agent.delta', payload: { runId: 'r', messageKey: 'k', reset: true } },
    wrongType: { type: 'agent.delta', payload: { runId: 'r', messageKey: 'k', reset: false } },
  },
  {
    name: 'PublicEphemeral(reasoning)',
    schema: web.PublicEphemeralSchema,
    ok: { type: 'agent.reasoning_delta', payload: { runId: 'r', messageKey: 'k', textDelta: 'a' } },
    wrongType: { type: 'agent.reasoning_delta', payload: { runId: 'r', messageKey: 'k' } },
  },
  {
    name: 'PublicEphemeral(tool_status)',
    schema: web.PublicEphemeralSchema,
    ok: {
      type: 'agent.tool_status',
      payload: { runId: 'r', toolCallId: 'c', name: 'quote_route', phase: 'end', isError: false },
    },
    wrongType: { type: 'agent.tool_status', payload: { runId: 'r', toolCallId: 'c', name: 'n', phase: 'middle' } },
  },
];

// Extra field injected at the top level and inside the first nested object.
function withExtra(v: unknown): unknown {
  return { ...(v as object), userId: 'u-evil' };
}

describe('web schemas', () => {
  for (const c of cases) {
    it(`${c.name}: accepts valid, rejects extra field and wrong type`, () => {
      expect(Value.Check(c.schema, c.ok)).toBe(true);
      expect(Value.Check(c.schema, withExtra(c.ok))).toBe(false);
      expect(Value.Check(c.schema, c.wrongType)).toBe(false);
    });
  }

  it('rejects nested extra fields', () => {
    expect(Value.Check(web.UserResponseSchema, { user: { ...user, userId: 'x' } })).toBe(false);
    expect(
      Value.Check(web.QuoteResponseSchema, {
        quote: { sessionId: 's1', quote: { ...quote, x: 1 }, booking: { status: 'available' } },
      }),
    ).toBe(false);
  });

  it('login body has no length bypass', () => {
    expect(Value.Check(web.LoginBodySchema, { username: '' })).toBe(false);
    expect(Value.Check(web.LoginBodySchema, { username: 'a'.repeat(65) })).toBe(false);
  });

  it('message text limit 1..2000', () => {
    expect(Value.Check(web.PostMessageBodySchema, { text: '', clientMessageId: uuid })).toBe(false);
    expect(Value.Check(web.PostMessageBodySchema, { text: 'a'.repeat(2001), clientMessageId: uuid })).toBe(false);
  });
});

describe('PublicEvent', () => {
  const ev = (type: string, payload: unknown, actor = 'agent') => ({ seq: 1, type, actor, ts: 't', payload });

  it('accepts each public event type', () => {
    const good = [
      ev('user.message', { text: 'hi', clientMessageId: uuid }, 'user'),
      ev('agent.message', { runId: 'r', messageKey: 'k', kind: 'reply', text: 'hello', template: 'x' }),
      ev('agent.message', { runId: 'r', messageKey: 'k', kind: 'process', processText: 'raw 1234 text' }),
      ev('agent.message', { runId: 'r', messageKey: 'k', toolCallId: 'c', toolName: 'quote_route', isError: false }),
      ev('agent.run_started', { runId: 'r' }),
      ev('agent.run_resumed', { runId: 'r', attempt: 2 }),
      ev('agent.run_completed', { runId: 'r' }),
      ev('agent.run_failed', { runId: 'r', code: 'LLM_ERROR' }),
      ev('agent.guard_violation', { runId: 'r', messageKey: 'k', action: 'regenerate' }),
      ev('agent.guard_violation', { runId: 'r', messageKey: 'k', action: 'replaced' }),
      ev('quote.offered', { quoteId: 'q' }),
      ev('booking.confirmed', { quoteId: 'q', ticketId: 't', ticketNo: 'n' }, 'system'),
      ev('booking.failed', { quoteId: 'q', code: 'QUOTE_NOT_OFFERED' }, 'system'),
      ev('hidden', {}, 'system'),
    ];
    for (const e of good) expect(Value.Check(web.PublicEventSchema, e), JSON.stringify(e)).toBe(true);
  });

  it('process messages carry processText, never text (M-1/M-2)', () => {
    const bad = ev('agent.message', { runId: 'r', messageKey: 'k', kind: 'process', text: 'leak' });
    expect(Value.Check(web.PublicEventSchema, bad)).toBe(false);
    const both = ev('agent.message', { runId: 'r', messageKey: 'k', kind: 'process', processText: 'a', text: 'b' });
    expect(Value.Check(web.PublicEventSchema, both)).toBe(false);
  });

  it('rejects internal-only fields and bad actions', () => {
    for (const extra of ['messageJson', 'viewText', 'hasToolCalls', 'data', 'thinking']) {
      const e = ev('agent.message', { runId: 'r', messageKey: 'k', kind: 'reply', text: 't', [extra]: 'x' });
      expect(Value.Check(web.PublicEventSchema, e), extra).toBe(false);
    }
    expect(
      Value.Check(
        web.PublicEventSchema,
        ev('agent.guard_violation', { runId: 'r', messageKey: 'k', action: 'stripped' }),
      ),
    ).toBe(false);
    expect(Value.Check(web.PublicEventSchema, ev('agent.run_started', { runId: 'r', model: 'm' }))).toBe(false);
    expect(Value.Check(web.PublicEventSchema, ev('unknown.type', {}))).toBe(false);
    expect(Value.Check(web.PublicEventSchema, { ...ev('hidden', {}), extra: 1 })).toBe(false);
    expect(Value.Check(web.PublicEventSchema, ev('quote.offered', { quoteId: 5 }))).toBe(false);
  });

  it('schemas expose no internal / secret-bearing keys', () => {
    const forbidden = new Set([
      'messageJson',
      'thinking',
      'reasoning',
      'viewText',
      'hasToolCalls',
      'data',
      'system',
      'offending',
      'guard',
      'profile',
      'usage',
      'fence',
      'piVersion',
      'summary',
      'summaryText',
    ]);
    const found: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
      else if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (forbidden.has(k)) found.push(`${path}.${k}`);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(web.PublicEventSchema, 'PublicEvent');
    walk(web.PublicEphemeralSchema, 'PublicEphemeral');
    expect(found).toEqual([]);
  });

  it('every schema object is closed (additionalProperties:false)', () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
      else if (node !== null && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (o['type'] === 'object' && o['properties'] !== undefined && o['additionalProperties'] !== false)
          open.push(path);
        for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      }
    };
    for (const [name, s] of Object.entries(web)) if (name.endsWith('Schema')) walk(s, name);
    expect(open).toEqual([]);
  });
});

describe('constants and error codes', () => {
  it('constants', () => {
    expect('PRICE_PER_KM_USD' in web).toBe(false); // M-13: the browser holds no price rate
    expect(web.DISPLAY_ROUNDING).toEqual({ distanceKmDecimals: 2, priceUsdDecimals: 2 });
  });
  it('ErrorCode is the merged enum: 19 codes of A-01 §4.6 + 16 agent-side codes (M-12)', () => {
    expect(Object.values(web.ErrorCode)).toHaveLength(35);
    for (const [k, v] of Object.entries(web.ErrorCode)) expect(k).toBe(v);
    for (const c of ['RUN_TIMEOUT', 'LLM_ERROR', 'CITY_NOT_FOUND', 'QUOTE_ALREADY_BOOKED', 'CONTEXT_CORRUPT']) {
      expect(Value.Check(web.ErrorCodeSchema, c)).toBe(true);
    }
    expect(Value.Check(web.ErrorCodeSchema, 'NOPE')).toBe(false);
  });
  it('every A-01 §4.6 code has an HTTP status', () => {
    const entries = Object.entries(web.ERROR_HTTP_STATUS);
    expect(entries).toHaveLength(19);
    for (const [code, status] of entries) {
      expect(code in web.ErrorCode).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
    }
    expect(web.ErrorCode.QUOTE_NOT_OFFERED).toBe('QUOTE_NOT_OFFERED');
  });
  it('no MASK_TOKEN (M-2)', () => {
    expect('MASK_TOKEN' in web).toBe(false);
  });
});

describe('web entry isolation', () => {
  // import.meta.glob (not node:fs): the repo depcruise rule forbids IO imports under packages/contracts
  const sources = (
    import.meta as unknown as {
      glob: (p: string, o: object) => Record<string, string>;
    }
  ).glob('../src/web/*.ts', { query: '?raw', import: 'default', eager: true });
  const files = Object.entries(sources);
  it('has source files', () => expect(files.length).toBeGreaterThan(0));
  for (const [f, src] of files) {
    it(`${f}: only imports typebox or sibling files`, () => {
      const specs = [...src.matchAll(/^\s*(?:import|export)b[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1] ?? '');
      const bare = [...src.matchAll(/bimport\s*\(\s*['"]([^'"]+)['"]|brequire\s*\(\s*['"]([^'"]+)['"]/g)];
      expect(bare).toEqual([]);
      for (const s of specs) {
        expect(s).not.toMatch(/^node:/);
        expect(s).not.toMatch(/\/server/);
        expect(s === 'typebox' || s.startsWith('./')).toBe(true);
      }
    });
  }
});

describe('M-12 / M-15 public schemas', () => {
  const evBase = { seq: 1, actor: 'agent', ts: '2026-11-19T00:00:00Z' };
  const e = (type: string, payload: unknown) => ({ ...evBase, type, payload });
  it('run_failed.code and booking.failed.code are ErrorCodes', () => {
    expect(Value.Check(web.PublicEventSchema, e('agent.run_failed', { runId: 'r', code: 'RUN_TIMEOUT' }))).toBe(true);
    expect(Value.Check(web.PublicEventSchema, e('agent.run_failed', { runId: 'r', code: 'NOPE' }))).toBe(false);
    expect(Value.Check(web.PublicEventSchema, e('booking.failed', { quoteId: 'q', code: 'BOOKING_UNAVAILABLE' }))).toBe(
      true,
    );
    expect(Value.Check(web.PublicEventSchema, e('booking.failed', { quoteId: 'q', code: 'free text' }))).toBe(false);
  });
  it('TicketSummary / QuoteLeg / QuoteDisplay are defined in web', () => {
    const ok = {
      ticketNo: 'OA-JKMNPQRS',
      from: 'A',
      to: 'C',
      legs: [{ from: 'A', to: 'B' }],
      transferCities: ['B'],
      display: { legs: ['1.00'], totalDistanceKm: '1.00', priceUsd: '0.13' },
    };
    expect(Value.Check(web.TicketSummarySchema, ok)).toBe(true);
    expect(Value.Check(web.TicketSummarySchema, { ...ok, priceCents: 13 })).toBe(false);
    expect(Value.Check(web.TicketSummarySchema, { ...ok, legs: [{ from: 'A', to: 'B', distanceKm: 1 }] })).toBe(false);
    expect(Value.Check(web.QuoteLegSchema, { from: 'A', to: 'B', distanceKm: 1.5 })).toBe(true);
    expect(Value.Check(web.QuoteDisplaySchema, { legs: [], totalDistanceKm: '1.00', priceUsd: '0.13' })).toBe(true);
  });
  it('M-15: clientMessageId is checked by the uuid pattern, not a format', () => {
    const body = (id: string) => ({ text: 'hi', clientMessageId: id });
    expect(Value.Check(web.PostMessageBodySchema, body('123e4567-e89b-12d3-a456-426614174000'))).toBe(true);
    expect(Value.Check(web.PostMessageBodySchema, body('123E4567-E89B-12D3-A456-426614174000'))).toBe(true);
    expect(Value.Check(web.PostMessageBodySchema, body('not-a-uuid'))).toBe(false);
    expect(Value.Check(web.PostMessageBodySchema, body('123e4567-e89b-12d3-a456-42661417400'))).toBe(false);
    expect(new RegExp(web.UUID_PATTERN).test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });
  it('M-19 step 1: login username is 1..64 raw (the 1..32 normalized check is the server job)', () => {
    expect(Value.Check(web.LoginBodySchema, { username: 'a'.repeat(64) })).toBe(true);
    expect(Value.Check(web.LoginBodySchema, { username: 'a'.repeat(65) })).toBe(false);
    expect(Value.Check(web.LoginBodySchema, { username: '' })).toBe(false);
  });
});

describe('M-17 public ephemeral view', () => {
  it('is { type, payload } and rejects a fence', () => {
    const ok = { type: 'agent.reasoning_delta', payload: { runId: 'r', messageKey: 'k', textDelta: 'x' } };
    expect(Value.Check(web.PublicEphemeralSchema, ok)).toBe(true);
    expect(Value.Check(web.PublicEphemeralSchema, { ...ok, fence: 3 })).toBe(false);
    expect(Value.Check(web.PublicEphemeralSchema, { ...ok, seq: 3 })).toBe(false);
    expect(Value.Check(web.PublicEphemeralSchema, { ...ok, sessionId: 's' })).toBe(false);
  });
});
