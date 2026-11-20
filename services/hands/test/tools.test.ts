// Acceptance 1 (T08): every tool — normal path, every business error code, idempotent replay.
// Real Postgres (fb_hands grants) + FlightCore / memory stand-ins (test/fakes). Expected numbers come from the
// fake's fixed coordinates: Shanghai(0,0) -> Dubai(3000,4000) = 5000 km, Dubai -> São Paulo(3000,10000) = 6000 km.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteResponse } from '@fb/contracts/tools';
import type { Quote, TicketView } from '@fb/contracts/web';
import { startHarness, type Harness } from './support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const okData = <T>(r: ExecuteResponse): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.data as T;
};
const errOf = (r: ExecuteResponse) => {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r)}`);
  return r.error as { code: string; llmText: string; data?: Record<string, unknown> };
};

/** Calling twice with one toolCallId must return byte-identical JSON (stored first response). */
async function replayed(s: { token: string }, name: string, input: Record<string, unknown>) {
  const toolCallId = `call_${randomUUID()}`;
  const first = await h.call(s, name, input, { toolCallId });
  const second = await h.call(s, name, input, { toolCallId });
  expect(second).toEqual(first);
  return first;
}

describe('resolve_city', () => {
  it('exact hub, exact unserved with nearest served, ambiguous, suggest, not_found', async () => {
    const s = await h.newSession();
    const exact = await h.call(s, 'resolve_city', { original: '上海', candidates: ['shanghai'] });
    expect(exact).toMatchObject({ ok: true, llmText: 'exact: Shanghai (hub, served).' });
    expect(okData<{ matchedBy: unknown }>(exact).matchedBy).toEqual({ source: 'candidate', index: 0 });

    const austin = await h.call(s, 'resolve_city', { original: 'Austin', candidates: ['Austin'] });
    expect(austin).toMatchObject({
      ok: true,
      llmText: 'exact: Austin (NOT served). Nearest served city: Copenhagen (120.00 km away).',
      data: { status: 'exact', matches: [{ city: 'Austin', served: false, nearestServed: { city: 'Copenhagen' } }] },
    });

    const amb = await h.call(s, 'resolve_city', { original: '圣何塞', candidates: ['San Jose'] });
    expect(okData<{ status: string; matches: unknown[] }>(amb).status).toBe('ambiguous');
    expect(amb.ok && amb.llmText).toBe(
      "ambiguous: 2 different cities share this name: 'San Jose' (direct flights to Tokyo) and 'San José' (direct flights to Sydney, Tokyo). Ask the user which one.",
    );

    const sug = await h.call(s, 'resolve_city', { original: 'x', candidates: ['Sao Paolo'] });
    const sd = okData<{ status: string; matches: { city: string; score: number }[] }>(sug);
    expect(sd.status).toBe('suggest');
    expect(sd.matches.map((m) => m.city)).toContain('São Paulo');
    expect(sug.ok && sug.llmText).toMatch(/^suggest: no exact match\. Closest names: .*São Paulo \(0\.\d\d\)/);

    const nf = await h.call(s, 'resolve_city', { original: 'qqqq', candidates: ['Qwxyzv'] });
    expect(nf).toEqual({
      ok: true,
      llmText: 'not_found: no city with a similar name in the Ocean Above network.',
      data: { status: 'not_found', matches: [] },
    });
  });

  it('replays the stored response for the same toolCallId', async () => {
    const s = await h.newSession();
    await replayed(s, 'resolve_city', { original: 'Zurich', candidates: ['Zurich'] });
  });
});

describe('quote_route', () => {
  it('creates an immutable quote with flight-core numbers and a number-free llmText', async () => {
    const s = await h.newSession();
    const r = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'São Paulo' });
    const q = okData<Quote>(r);
    expect(q.quoteId).toMatch(/^q_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(q.legs).toEqual([
      { from: 'Shanghai', to: 'Dubai', distanceKm: 5000 },
      { from: 'Dubai', to: 'São Paulo', distanceKm: 6000 },
    ]);
    expect(q).toMatchObject({
      transferCities: ['Dubai'],
      totalDistanceKm: 11000,
      priceCents: 143000,
      display: { legs: ['5000.00', '6000.00'], totalDistanceKm: '11000.00', priceUsd: '1430.00' },
      dataSha256: 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f',
    });
    const text = r.ok ? r.llmText : '';
    expect(text).toBe(
      `Quote ${q.quoteId} created: Shanghai → Dubai → São Paulo (2 legs, 1 transfer at Dubai). Distance and price are shown to the user on the quote card. Call offer_booking with this quoteId now. Asking for the route is enough to show the card; the card does not book the ticket.`,
    );
    // H-01 / A-02 §7.2: no distance or price figure; the only numbers besides the quote id are the leg count
    // and the transfer count, exactly as in the spec example "(2 legs, 1 transfer at Dubai)"
    expect(text.replace(q.quoteId, '').match(/\d+/g)).toEqual(['2', '1']);

    const row = await h.db.owner.query(
      'SELECT user_id, session_id, from_city, to_city, payload FROM app.quotes WHERE id = $1',
      [q.quoteId],
    );
    expect(row.rows[0]).toMatchObject({
      user_id: s.uid,
      session_id: s.sid,
      from_city: 'Shanghai',
      to_city: 'São Paulo',
    });
    expect(row.rows[0]?.payload).toEqual(q);
  });

  it('direct route text', async () => {
    const s = await h.newSession();
    const r = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Tokyo' });
    expect(r.ok && r.llmText).toContain('Shanghai → Tokyo (1 leg, direct)');
  });

  it('CITY_NOT_FOUND / CITY_NOT_SERVED / SAME_CITY / NO_ROUTE, none of which writes a quote', async () => {
    const s = await h.newSession();
    expect(errOf(await h.call(s, 'quote_route', { from: 'shanghai', to: 'Tokyo' }))).toMatchObject({
      code: 'CITY_NOT_FOUND',
      llmText: "'shanghai' is not an exact city name. Call resolve_city first and use the city it returns.",
    });
    expect(errOf(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Austin' }))).toEqual({
      code: 'CITY_NOT_SERVED',
      llmText: 'Austin has no Ocean Above flights. Nearest served city: Copenhagen (120.00 km away).',
      data: { city: 'Austin', nearestServed: { city: 'Copenhagen', distanceKm: '120.00' } },
    });
    expect(errOf(await h.call(s, 'quote_route', { from: 'Tokyo', to: 'Tokyo' })).code).toBe('SAME_CITY');
    expect(errOf(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Reykjavik' })).code).toBe('NO_ROUTE');
    expect(await h.count('quotes', 'session_id = $1', [s.sid])).toBe(0);
  });

  it('NFC-normalises the name before the exact check', async () => {
    const s = await h.newSession();
    const r = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'São Paulo' }); // decomposed ã
    expect(okData<Quote>(r).to).toBe('São Paulo');
  });

  it('replay returns the same quote and inserts no second row', async () => {
    const s = await h.newSession();
    const first = await replayed(s, 'quote_route', { from: 'Shanghai', to: 'Sydney' });
    expect(await h.count('quotes', 'session_id = $1', [s.sid])).toBe(1);
    expect(okData<Quote>(first).transferCities).toEqual(['Tokyo']);
  });
});

describe('offer_booking', () => {
  it('records an offer row and never books', async () => {
    const s = await h.newSession();
    const q = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    const toolCallId = `call_${randomUUID()}`;
    const r = await h.call(s, 'offer_booking', { quoteId: q.quoteId }, { toolCallId });
    expect(r).toEqual({
      ok: true,
      llmText: `Booking card shown for ${q.quoteId}. The user must click the confirm button on the card to book. You cannot book on their behalf.`,
      data: { quoteId: q.quoteId, offered: true },
    });
    expect(
      await h.count('quote_offers', 'quote_id = $1 AND session_id = $2 AND tool_call_id = $3', [
        q.quoteId,
        s.sid,
        toolCallId,
      ]),
    ).toBe(1);
    expect(await h.count('tickets', 'quote_id = $1', [q.quoteId])).toBe(0);
    // the same quote may be offered again (another toolCallId)
    expect((await h.call(s, 'offer_booking', { quoteId: q.quoteId })).ok).toBe(true);
    expect(await h.count('quote_offers', 'quote_id = $1', [q.quoteId])).toBe(2);
  });

  it('QUOTE_NOT_FOUND for unknown ids and for quotes of another session', async () => {
    const s = await h.newSession();
    expect(errOf(await h.call(s, 'offer_booking', { quoteId: 'q_NOPE' })).code).toBe('QUOTE_NOT_FOUND');
    const other = await h.newSession({ userId: s.uid }); // same user, different conversation
    const q = okData<Quote>(await h.call(other, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    expect(errOf(await h.call(s, 'offer_booking', { quoteId: q.quoteId })).code).toBe('QUOTE_NOT_FOUND');
    expect(await h.count('quote_offers', 'quote_id = $1', [q.quoteId])).toBe(0);
  });

  it('QUOTE_ALREADY_BOOKED once a ticket exists', async () => {
    const s = await h.newSession();
    const q = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    await h.issueTicket(q, s.uid, s.sid);
    const e = errOf(await h.call(s, 'offer_booking', { quoteId: q.quoteId }));
    expect(e.code).toBe('QUOTE_ALREADY_BOOKED');
    expect(e.data?.ticketNo).toMatch(/^OA-/);
    expect(await h.count('quote_offers', 'quote_id = $1', [q.quoteId])).toBe(0);
  });

  it('replay inserts a single offer row', async () => {
    const s = await h.newSession();
    const q = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    await replayed(s, 'offer_booking', { quoteId: q.quoteId });
    expect(await h.count('quote_offers', 'quote_id = $1', [q.quoteId])).toBe(1);
  });
});

describe('list_my_tickets', () => {
  it('newest first, numbers copied from display, city filter, limit/total, own tickets only', async () => {
    const s = await h.newSession();
    const other = await h.newSession();
    const q1 = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'São Paulo' }));
    const q2 = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Tokyo' }));
    const q3 = okData<Quote>(await h.call(other, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    await h.issueTicket(q1, s.uid, s.sid, '2026-11-10T08:00:00.000Z');
    await h.issueTicket(q2, s.uid, s.sid, '2026-11-18T08:00:00.000Z');
    await h.issueTicket(q3, other.uid, other.sid, '2026-11-19T08:00:00.000Z');

    const all = await h.call(s, 'list_my_tickets', {});
    const d = okData<{ tickets: TicketView[]; total: number }>(all);
    expect(d.total).toBe(2);
    expect(d.tickets.map((t) => t.quoteId)).toEqual([q2.quoteId, q1.quoteId]);
    expect(d.tickets[1]).toMatchObject({ from: 'Shanghai', to: 'São Paulo', priceCents: 143000, itinerary: q1 });
    const [t2, t1] = d.tickets;
    expect(all.ok && all.llmText).toBe(
      `2 tickets (newest first): [${t2?.ticketNo} 2026-11-18] Shanghai→Tokyo, 3000.00 km, USD 390.00; ` +
        `[${t1?.ticketNo} 2026-11-10] Shanghai→Dubai→São Paulo, 11000.00 km, USD 1430.00`,
    );

    const dubai = okData<{ tickets: TicketView[]; total: number }>(
      await h.call(s, 'list_my_tickets', { city: 'Dubai' }),
    );
    expect(dubai.tickets.map((t) => t.quoteId)).toEqual([q1.quoteId]); // Dubai is a transfer endpoint of q1

    const limited = await h.call(s, 'list_my_tickets', { limit: 1 });
    expect(okData<{ tickets: TicketView[]; total: number }>(limited)).toMatchObject({ total: 2 });
    expect(limited.ok && limited.llmText).toMatch(/^2 tickets, showing the newest 1: /);

    const none = await h.call(s, 'list_my_tickets', { city: 'Sydney' });
    expect(none).toEqual({ ok: true, llmText: 'No tickets involving Sydney.', data: { tickets: [], total: 0 } });
  });

  it('CITY_NOT_FOUND for a non-canonical city filter', async () => {
    const s = await h.newSession();
    expect(errOf(await h.call(s, 'list_my_tickets', { city: 'dubai' })).code).toBe('CITY_NOT_FOUND');
  });

  it('replay', async () => {
    const s = await h.newSession();
    await replayed(s, 'list_my_tickets', { limit: 5 });
  });
});

// Samples det-pref-001..008 from eval/cases/deterministic/resolve.yaml (main 6659c82), adapted to the fake graph
// (all their cities exist in it). Not edited.
const PREF_SAMPLES: { id: string; value: string; stored?: string; code?: string; candidates?: string[] }[] = [
  { id: 'det-pref-001', value: 'shanghai', stored: 'Shanghai' },
  { id: 'det-pref-002', value: 'SHANGHAI', stored: 'Shanghai' },
  { id: 'det-pref-003', value: 'Shanghai', stored: 'Shanghai' },
  { id: 'det-pref-004', value: '上海', code: 'INVALID_INPUT', candidates: [] },
  { id: 'det-pref-005', value: 'San Jose', code: 'CITY_AMBIGUOUS', candidates: ['San Jose', 'San José'] },
  { id: 'det-pref-006', value: 'Sao Paolo', code: 'INVALID_INPUT', candidates: ['São Paulo'] },
  { id: 'det-pref-007', value: 'tromso', stored: 'Tromsø' },
  { id: 'det-pref-008', value: 'Austin', stored: 'Austin' },
];

describe('save_preference / forget_preference', () => {
  for (const c of PREF_SAMPLES) {
    it(`${c.id}: home_city '${c.value}'`, async () => {
      const s = await h.newSession({ lastUserSeq: 9 });
      const r = await h.call(s, 'save_preference', { key: 'home_city', value: c.value }, { inputSeq: 7 });
      const rows = await h.db.owner.query(
        'SELECT value, source_session_id, source_seq FROM app.user_memories WHERE user_id = $1',
        [s.uid],
      );
      if (c.stored !== undefined) {
        expect(r).toEqual({
          ok: true,
          llmText: `Saved: home_city = ${c.stored}.`,
          data: { key: 'home_city', value: c.stored },
        });
        expect(rows.rows).toEqual([{ value: c.stored, source_session_id: s.sid, source_seq: '7' }]);
      } else {
        const e = errOf(r);
        expect(e.code).toBe(c.code);
        // det-pref-006 only requires São Paulo among the candidates
        if (c.id === 'det-pref-006') expect(e.data?.candidates).toContain('São Paulo');
        else expect(e.data?.candidates).toEqual(c.candidates);
        expect(rows.rows).toEqual([]);
      }
    });
  }

  it('M-23 ④: non-Latin value asks for the English name and offers no candidates', async () => {
    const s = await h.newSession();
    const e = errOf(await h.call(s, 'save_preference', { key: 'home_city', value: '上海' }));
    expect(e).toEqual({
      code: 'INVALID_INPUT',
      llmText:
        "'上海' is not an English city name. Please pass the English city name (resolve it with resolve_city first).",
      data: { candidates: [] },
    });
  });

  it('INVALID_INPUT for not_found lists no candidates; ambiguous text', async () => {
    const s = await h.newSession();
    expect(errOf(await h.call(s, 'save_preference', { key: 'home_city', value: 'Qwxyzv' }))).toEqual({
      code: 'INVALID_INPUT',
      llmText: "'Qwxyzv' is not an exact city name. Resolve it first or ask the user.",
      data: { candidates: [] },
    });
    expect(errOf(await h.call(s, 'save_preference', { key: 'home_city', value: 'San Jose' })).llmText).toBe(
      "'San Jose' matches 2 cities: San Jose, San José. Ask the user which one.",
    );
  });

  it('preferred_language, then forget writes a tombstone (append-only)', async () => {
    const s = await h.newSession();
    expect(await h.call(s, 'save_preference', { key: 'preferred_language', value: 'zh' })).toEqual({
      ok: true,
      llmText: 'Saved: preferred_language = zh.',
      data: { key: 'preferred_language', value: 'zh' },
    });
    expect(await h.call(s, 'forget_preference', { key: 'preferred_language' })).toEqual({
      ok: true,
      llmText: 'Forgot: preferred_language.',
      data: { key: 'preferred_language' },
    });
    const rows = await h.db.owner.query(
      'SELECT value FROM app.user_memories WHERE user_id = $1 ORDER BY created_at, id',
      [s.uid],
    );
    expect(rows.rows).toEqual([{ value: 'zh' }, { value: null }]);
  });

  it('replays insert a single memory row each', async () => {
    const s = await h.newSession();
    await replayed(s, 'save_preference', { key: 'home_city', value: 'Tokyo' });
    await replayed(s, 'forget_preference', { key: 'home_city' });
    expect(await h.count('user_memories', 'user_id = $1', [s.uid])).toBe(2);
  });
});

describe('error responses are replayed from tool_calls like successes', () => {
  it('every hands business error code: same toolCallId -> identical error, one tool_calls row, no side effect', async () => {
    const s = await h.newSession();
    const booked = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    await h.issueTicket(booked, s.uid, s.sid);
    const cases: [string, string, Record<string, unknown>][] = [
      ['CITY_NOT_FOUND', 'quote_route', { from: 'shanghai', to: 'Tokyo' }],
      ['CITY_NOT_SERVED', 'quote_route', { from: 'Austin', to: 'Tokyo' }],
      ['SAME_CITY', 'quote_route', { from: 'Tokyo', to: 'Tokyo' }],
      ['NO_ROUTE', 'quote_route', { from: 'Reykjavik', to: 'Tokyo' }],
      ['QUOTE_NOT_FOUND', 'offer_booking', { quoteId: 'q_MISSING' }],
      ['QUOTE_ALREADY_BOOKED', 'offer_booking', { quoteId: booked.quoteId }],
      ['CITY_NOT_FOUND', 'list_my_tickets', { city: 'tokyo' }],
      ['CITY_AMBIGUOUS', 'save_preference', { key: 'home_city', value: 'San Jose' }],
      ['INVALID_INPUT', 'save_preference', { key: 'home_city', value: 'Sao Paolo' }],
      ['INVALID_INPUT', 'resolve_city', { original: 'x', candidates: [] }],
      ['INVALID_INPUT', 'forget_preference', { key: 'avoid_transfer_city' }],
      ['UNKNOWN_TOOL', 'book_ticket', { quoteId: booked.quoteId }],
    ];
    const quotesBefore = await h.count('quotes', 'session_id = $1', [s.sid]);
    for (const [code, name, input] of cases) {
      const toolCallId = `call_${randomUUID()}`;
      const first = await h.call(s, name, input, { toolCallId });
      expect({ name, code: errOf(first).code }).toEqual({ name, code });
      expect(await h.call(s, name, input, { toolCallId })).toEqual(first);
      expect(await h.count('tool_calls', 'session_id = $1 AND tool_call_id = $2', [s.sid, toolCallId])).toBe(1);
    }
    expect(await h.count('quotes', 'session_id = $1', [s.sid])).toBe(quotesBefore);
    expect(await h.count('quote_offers', 'session_id = $1', [s.sid])).toBe(0);
    expect(await h.count('user_memories', 'user_id = $1', [s.uid])).toBe(0);
  });

  it('a replay returns the stored response even after the world changed (offer, then ticket issued)', async () => {
    const s = await h.newSession();
    const q = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Tokyo' }));
    const toolCallId = `call_${randomUUID()}`;
    const first = await h.call(s, 'offer_booking', { quoteId: q.quoteId }, { toolCallId });
    expect(first.ok).toBe(true);
    await h.issueTicket(q, s.uid, s.sid);
    expect(await h.call(s, 'offer_booking', { quoteId: q.quoteId }, { toolCallId })).toEqual(first);
    expect(errOf(await h.call(s, 'offer_booking', { quoteId: q.quoteId })).code).toBe('QUOTE_ALREADY_BOOKED');
    expect(await h.count('quote_offers', 'quote_id = $1', [q.quoteId])).toBe(1);
  });
});

describe('sys.profile_snapshot', () => {
  it('uses the recall rule over stored rows (tombstone, deletion, no fallback) and derived tickets', async () => {
    const s = await h.newSession();
    const snap = async () => okData<Record<string, unknown>>(await h.call(s, 'sys.profile_snapshot', {}));
    expect(await snap()).toEqual({ frequentRoutes: [], ticketCount: 0 });

    await h.call(s, 'save_preference', { key: 'home_city', value: 'Shanghai' });
    await h.call(s, 'save_preference', { key: 'home_city', value: 'Austin' });
    expect((await snap()).homeCity).toEqual({ city: 'Austin', served: false });

    // user deletes the newest row in the profile panel (gateway writes memory_deletions) -> absent, no fallback
    const newest = await h.db.owner.query<{ id: string }>(
      "SELECT id FROM app.user_memories WHERE user_id = $1 AND value = 'Austin'",
      [s.uid],
    );
    await h.db.owner.query('INSERT INTO app.memory_deletions (memory_id, user_id) VALUES ($1, $2)', [
      newest.rows[0]?.id,
      s.uid,
    ]);
    expect((await snap()).homeCity).toBeUndefined();

    const q = okData<Quote>(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }));
    await h.issueTicket(q, s.uid, s.sid, '2026-11-18T10:00:00.000Z');
    expect(await snap()).toMatchObject({
      ticketCount: 1,
      frequentRoutes: [{ from: 'Shanghai', to: 'Dubai', count: 1 }],
      lastTicket: { from: 'Shanghai', to: 'Dubai' },
    });
    expect(await h.count('tool_calls', "session_id = $1 AND name LIKE 'sys.%'", [s.sid])).toBe(0);
  });
});
