// Acceptance 7: the confirm chain, gateway side (A-01 §5.2, §4.6 mapping table; D-39 / D-51; M-21). The fake booking
// implements T07's contract against the real tables: Bearer booking_service_token, body exactly
// { quoteId, userId, requestId } (extra field -> 400), a repeated confirm answers 200 { ticket, alreadyBooked: true }.
import { ConfirmCreatedResponseSchema, ConfirmReplayResponseSchema } from '@fb/contracts/web';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/validate.ts';
import { Browser, type Res } from './helpers/client.ts';
import { BOOKING_TOKEN, seedQuote, skipReason, startEnv, type Env } from './helpers/env.ts';

const reason = await skipReason();
if (reason) console.warn(`[gateway confirm tests skipped] ${reason}`);
let env: Env;
beforeAll(async () => {
  if (!reason) env = await startEnv();
}, 180_000);
afterAll(async () => {
  await env?.close();
});
afterEach(() => {
  if (env) env.booking.mode = 'normal';
});

const P = '/api/v1';
function expectErr(r: Res, status: number, code: string): void {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error.code, JSON.stringify(r.body)).toBe(code);
}
async function setup(offered = true): Promise<{ b: Browser; sid: string; qid: string }> {
  const b = new Browser(env.gw.publicApp);
  await b.login();
  const sid = await b.newSession('en');
  await b.say(sid, 'book it');
  const qid = await seedQuote(env.owner, { userId: b.userId, sessionId: sid, offered });
  return { b, sid, qid };
}
const confirm = (b: Browser, qid: string): Promise<Res> => b.raw('POST', `${P}/quotes/${qid}/confirm`);
async function events(sid: string, type?: string): Promise<Record<string, unknown>[]> {
  const { rows } = await env.owner.query(
    `SELECT seq, type, actor, idempotency_key, payload FROM app.events WHERE session_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY seq`,
    type ? [sid, type] : [sid],
  );
  return rows as Record<string, unknown>[];
}
async function ticketCount(qid: string): Promise<number> {
  const { rows } = await env.owner.query('SELECT count(*)::int AS n FROM app.tickets WHERE quote_id = $1', [qid]);
  return (rows[0] as { n: number }).n;
}
const ringsFor = (sid: string): string[] => env.rings.filter((r) => r.sessionId === sid).map((r) => r.jobId);

describe.skipIf(reason !== null)('confirm: the same quote is booked exactly once (acceptance 7)', () => {
  it('201 then 200 alreadyBooked with the same ticket; one ticket row, one booking.confirmed, no doorbell', async () => {
    const { b, sid, qid } = await setup();
    const first = await confirm(b, qid);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(check(ConfirmCreatedResponseSchema, first.body)).toBe(true);
    expect(first.body.ticket).toMatchObject({
      quoteId: qid,
      sessionId: sid,
      priceCents: 36352,
      from: 'Oslo',
      to: 'Lisboa',
    });
    expect(first.body.ticket.ticketNo).toBe(`OA-${first.body.ticket.ticketId.slice(-8)}`);

    const second = await confirm(b, qid);
    expect(second.status).toBe(200);
    expect(check(ConfirmReplayResponseSchema, second.body)).toBe(true);
    expect(second.body).toEqual({ ticket: first.body.ticket, alreadyBooked: true });

    expect(await ticketCount(qid)).toBe(1);
    const confirmed = await events(sid, 'booking.confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ actor: 'system', idempotency_key: `booking:${qid}` });
    expect(confirmed[0]!.payload).toEqual({
      quoteId: qid,
      ticketId: first.body.ticket.ticketId,
      ticketNo: first.body.ticket.ticketNo,
      summary: {
        ticketNo: first.body.ticket.ticketNo,
        from: 'Oslo',
        to: 'Lisboa',
        legs: [
          { from: 'Oslo', to: 'Paris' },
          { from: 'Paris', to: 'Lisboa' },
        ],
        transferCities: ['Paris'],
        display: { legs: ['1343.21', '1453.07'], totalDistanceKm: '2796.28', priceUsd: '363.52' },
      },
    });
    // D-39: only the user.message rang; booking.* never wakes the harness; consumption tracking unchanged
    expect(ringsFor(sid)).toEqual([`wake-${sid}-1`]);
    const { rows } = await env.owner.query('SELECT last_user_seq, consumed_up_to_seq FROM app.sessions WHERE id = $1', [
      sid,
    ]);
    expect(rows[0]).toEqual({ last_user_seq: '1', consumed_up_to_seq: '0' });
  });

  it('20 concurrent confirms: exactly one 201, nineteen 200 alreadyBooked, one ticket, one event', async () => {
    const { b, sid, qid } = await setup();
    const rs = await Promise.all(Array.from({ length: 20 }, () => confirm(b, qid)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200 && r.body.alreadyBooked === true)).toHaveLength(19);
    expect(new Set(rs.map((r) => r.body.ticket.ticketId)).size).toBe(1);
    expect(await ticketCount(qid)).toBe(1);
    expect(await events(sid, 'booking.confirmed')).toHaveLength(1);
    expect(ringsFor(sid)).toEqual([`wake-${sid}-1`]);
  });

  it('calls booking with exactly { quoteId, userId (from the cookie), requestId = traceId } + Bearer + traceparent', async () => {
    const { b, qid } = await setup();
    const n = env.booking.requests.length;
    const r = await confirm(b, qid);
    expect(r.status).toBe(201);
    const req = env.booking.requests[n]!;
    expect(req.headers.authorization).toBe(`Bearer ${BOOKING_TOKEN}`);
    expect(Object.keys(req.body as object).sort()).toEqual(['quoteId', 'requestId', 'userId']);
    expect(req.body).toEqual({ quoteId: qid, userId: b.userId, requestId: r.headers['x-trace-id'] });
    expect(String(req.headers.traceparent)).toMatch(
      new RegExp(`^00-${String(r.headers['x-trace-id'])}-[0-9a-f]{16}-0[01]$`),
    );
  });

  it('booking committed but its reply was lost (503): no event; the retry gets alreadyBooked and back-fills once', async () => {
    const { b, sid, qid } = await setup();
    env.booking.mode = 'commit-then-500';
    expectErr(await confirm(b, qid), 503, 'BOOKING_UNAVAILABLE');
    expect(await ticketCount(qid)).toBe(1);
    expect(await events(sid, 'booking.confirmed')).toHaveLength(0);
    expect(await events(sid, 'booking.failed')).toHaveLength(0);
    env.booking.mode = 'normal';
    const retry = await confirm(b, qid);
    expect(retry.status).toBe(200);
    expect(retry.body.alreadyBooked).toBe(true);
    expect(await events(sid, 'booking.confirmed')).toHaveLength(1);
    expect((await confirm(b, qid)).status).toBe(200);
    expect(await events(sid, 'booking.confirmed')).toHaveLength(1);
  });
});

describe.skipIf(reason !== null)('booking -> public mapping (A-01 §4.6) and failure semantics (§5.2)', () => {
  it('409 QUOTE_NOT_OFFERED: no ticket, booking.failed written as system to the quote session, no doorbell', async () => {
    const { b, sid, qid } = await setup(false);
    const r = await confirm(b, qid);
    expectErr(r, 409, 'QUOTE_NOT_OFFERED');
    expect(await ticketCount(qid)).toBe(0);
    const failed = await events(sid, 'booking.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      actor: 'system',
      idempotency_key: `booking-failed:${qid}:${String(r.headers['x-trace-id'])}`,
      payload: { quoteId: qid, code: 'QUOTE_NOT_OFFERED' },
    });
    expect(ringsFor(sid)).toEqual([`wake-${sid}-1`]);
    const pub = await b.get(`${P}/sessions/${sid}/events`);
    expect(pub.body.events.at(-1)).toMatchObject({
      type: 'booking.failed',
      actor: 'system',
      payload: { quoteId: qid, code: 'QUOTE_NOT_OFFERED' },
    });
  });

  it('404 QUOTE_NOT_FOUND (unknown / malformed / someone else’s): nothing written anywhere', async () => {
    const { b, sid } = await setup();
    const n = env.booking.calls;
    expectErr(await confirm(b, 'q_0123456789ABCDEFGHJKMNPQRS'), 404, 'QUOTE_NOT_FOUND');
    expectErr(await confirm(b, 'nope'), 404, 'QUOTE_NOT_FOUND');
    expect(env.booking.calls).toBe(n + 1); // malformed ids never reach booking
    expect(await events(sid)).toHaveLength(1);
  });

  it('booking 5xx / timeout -> 503 BOOKING_UNAVAILABLE, nothing written, retry is safe', async () => {
    const { b, sid, qid } = await setup();
    env.booking.mode = 'down';
    expectErr(await confirm(b, qid), 503, 'BOOKING_UNAVAILABLE');
    env.booking.mode = 'hang';
    const t0 = Date.now();
    expectErr(await confirm(b, qid), 503, 'BOOKING_UNAVAILABLE');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500); // the 5 s timeout of §5.2
    expect(await events(sid)).toHaveLength(1);
    expect(await ticketCount(qid)).toBe(0);
    env.booking.mode = 'normal';
    expect((await confirm(b, qid)).status).toBe(201);
  });

  it('booking 400 / 401 / malformed success -> 500 INTERNAL + error log, nothing written', async () => {
    const { b, sid, qid } = await setup();
    const ticketLike = {
      ticketId: 't_0123456789ABCDEFGHJKMNPQRS',
      ticketNo: 'OA-HJKMNPQRS',
      sessionId: sid,
      quoteId: qid,
      from: 'A',
      to: 'B',
      itinerary: {},
      priceCents: 1,
      bookedAt: new Date().toISOString(),
    };
    const cases: { status: number; body: unknown }[] = [
      { status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'extra field', traceId: '0'.repeat(32) } } },
      { status: 401, body: { error: { code: 'SERVICE_AUTH_INVALID', message: 'x', traceId: '0'.repeat(32) } } },
      { status: 201, body: { ticket: { ...ticketLike, priceCents: 'free' } } }, // schema violation
      { status: 201, body: { ticket: { ...ticketLike, quoteId: 'q_ZZZZZZZZZZZZZZZZZZZZZZZZZZ' } } }, // other quote
      { status: 200, body: { ticket: ticketLike } }, // 200 without alreadyBooked
      { status: 404, body: { error: { code: 'TICKET_NOT_FOUND', message: 'x', traceId: '0'.repeat(32) } } },
    ];
    env.booking.mode = 'reply';
    for (const c of cases) {
      env.booking.reply = c;
      expectErr(await confirm(b, qid), 500, 'INTERNAL');
    }
    expect(await events(sid)).toHaveLength(1);
    expect(
      env.logLines.filter((l) => l.includes('"level":"error"') || l.includes('"level":50')).length,
    ).toBeGreaterThan(0);
  });
});

describe.skipIf(reason !== null)('Redis ACL', () => {
  it('no gateway command was refused during this file', async () => {
    expect(await env.aclDenials()).toEqual([]);
  });
});
