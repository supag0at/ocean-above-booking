// @vitest-environment jsdom
// Acceptance: every mock goes through the @fb/contracts/web schemas, and a violation fails the test.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import {
  ApiErrorSchema,
  EventsResponseSchema,
  ProfileResponseSchema,
  PublicEphemeralSchema,
  QuoteResponseSchema,
  SessionsPageSchema,
  TicketsPageSchema,
} from '@fb/contracts/web';
import { api, ApiRequestError } from '../api/client.ts';
import { createHandlers } from './handlers.ts';
import { ROUTES, createStore, makeQuote } from './store.ts';
import { assertSchema, matchesSchema } from './validate.ts';

const store = createStore();
const server = setupServer(...createHandlers(store, { speed: 0 }).handlers);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

describe('mini schema checker', () => {
  it('rejects extra properties, missing fields and wrong types', () => {
    expect(matchesSchema(SessionsPageSchema, { items: [] })).toBe(true);
    expect(matchesSchema(SessionsPageSchema, { items: [], extra: 1 })).toBe(false);
    expect(matchesSchema(SessionsPageSchema, {})).toBe(false);
    expect(matchesSchema(ApiErrorSchema, { error: { code: 'NOPE', message: 'm', traceId: 't' } })).toBe(false);
    expect(
      matchesSchema(PublicEphemeralSchema, {
        type: 'agent.delta',
        payload: { runId: 'r', messageKey: 'k', textDelta: 'x' },
      }),
    ).toBe(true);
  });
});

describe('seed data satisfies the contract', () => {
  it('sessions, events, quote, tickets, memories', () => {
    const s = store.sessions.get('sess_history')!;
    assertSchema(SessionsPageSchema, { items: [s.view] }, 'sessions');
    assertSchema(EventsResponseSchema, { events: s.events, hasMore: false }, 'events');
    const quote = [...store.quotes.values()][0]!;
    assertSchema(
      QuoteResponseSchema,
      { quote: { sessionId: quote.sessionId, quote: quote.quote, booking: { status: 'available' } } },
      'quote',
    );
    assertSchema(TicketsPageSchema, { items: store.tickets }, 'tickets');
    assertSchema(ProfileResponseSchema, { preferences: store.memories }, 'profile');
  });

  it('both San Jose and San José exist and are kept distinct (A-01 §9.7)', () => {
    const cities = new Set([ROUTES.direct.from, ROUTES.transfer.from]);
    expect(cities).toEqual(new Set(['San Jose', 'San José']));
    expect(makeQuote(store, ROUTES.transfer).from).toBe('San José');
  });

  it('seed history contains a process-kind message, a toolResult, a reply and a booking', () => {
    const types = store.sessions
      .get('sess_history')!
      .events.map((e) =>
        e.type === 'agent.message' ? `msg:${'kind' in e.payload ? e.payload.kind : 'tool'}` : e.type,
      );
    expect(types).toEqual(
      expect.arrayContaining([
        'msg:process',
        'msg:tool',
        'msg:reply',
        'quote.offered',
        'booking.confirmed',
        'agent.run_completed',
      ]),
    );
  });
});

describe('mock API behaves like the contract', () => {
  it('401 before login, error envelope validates', async () => {
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
  });

  it('login → me → sessions → events → tickets → profile', async () => {
    const user = await api.login('  Alice ');
    expect(user.username).toBe('alice');
    expect((await api.me()).id).toBe(user.id);
    expect((await api.listSessions()).items.length).toBeGreaterThan(0);
    expect((await api.listEvents('sess_history', 0)).events.length).toBeGreaterThan(0);
    expect((await api.listTickets()).items).toHaveLength(1);
    expect(await api.getProfile()).toHaveLength(2);
  });

  it('rejects over-long usernames and unknown resources', async () => {
    await expect(api.login('x'.repeat(40))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(api.getQuote('nope')).rejects.toBeInstanceOf(ApiRequestError);
    await expect(api.getTicket('nope')).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
  });

  it('confirm replays as alreadyBooked, memories can be deleted one by one and all at once', async () => {
    const q = makeQuote(store, ROUTES.direct);
    store.quotes.set(q.quoteId, { sessionId: 'sess_history', quote: q, ticketId: null });
    const t1 = await api.confirmQuote(q.quoteId);
    const t2 = await api.confirmQuote(q.quoteId);
    expect(t2.ticketId).toBe(t1.ticketId);
    await api.deleteMemory('3f1c2a4e-0b7d-4e55-9a10-6c2d8e1f0001');
    expect(await api.getProfile()).toHaveLength(1);
    await api.deleteAllMemories();
    expect(await api.getProfile()).toHaveLength(0);
  });

  it('a message produces a scripted run that ends in a figure-free reply and a quote', async () => {
    const s = await api.createSession('en');
    await api.postMessage(s.id, 'San Jose to Tokyo', crypto.randomUUID());
    await vi.waitFor(
      async () => expect((await api.listEvents(s.id, 0)).events.at(-1)?.type).toBe('agent.run_completed'),
      { timeout: 5000 },
    );
    const { events } = await api.listEvents(s.id, 0);
    const types = events.map((e) => e.type);
    expect(types).toContain('quote.offered');
    expect(types.at(-1)).toBe('agent.run_completed');
    const reply = events.find((e) => e.type === 'agent.message' && 'kind' in e.payload && e.payload.kind === 'reply');
    expect(reply && 'text' in (reply.payload as object) ? (reply.payload as { text: string }).text : '').not.toMatch(
      /\d/,
    );
  });
});
