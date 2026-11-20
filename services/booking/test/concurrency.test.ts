import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Pool } from '@fb/platform/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmBooking, type ConfirmBookingResult } from '../src/booking.ts';
import { buildBookingApp } from '../src/server.ts';
import { createQuote, createUser, ticketCount } from './support/fixtures.ts';
import { CONTAINER_HOOK_TIMEOUT_MS, dockerSocket, startPgContainer, type PgContainer } from './support/pg-container.ts';

const dockerOk = (await dockerSocket()) !== null;
const N = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dockerOk)('concurrent confirms (acceptance: one ticket per quote)', () => {
  let pg: PgContainer;
  let owner: Pool;
  let booking: Pool;

  beforeAll(async () => {
    pg = await startPgContainer('fb-t07-conc');
    owner = pg.pool('fb_owner', 5);
    booking = pg.pool('fb_booking', 40);
  }, CONTAINER_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await booking?.end();
    await owner?.end();
    await pg?.stop();
  });

  /** Holds an exclusive lock (waiters are counted via pg_locks: pg_stat_activity hides other roles' wait events from fb_owner) on quote_offers so every confirm blocks at step b; releases once `expected` are waiting. */
  async function withBarrier<T>(expected: number, fire: () => Promise<T>[]): Promise<T[]> {
    const holder = await owner.connect();
    let released = false;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE app.quote_offers IN ACCESS EXCLUSIVE MODE');
      const promises = fire();
      // avoid unhandled rejections while we poll
      for (const p of promises) p.catch(() => undefined);
      const deadline = Date.now() + 20_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const r = await owner.query<{ n: string }>(
          `SELECT count(DISTINCT pid)::text AS n FROM pg_locks
           WHERE locktype = 'relation' AND NOT granted AND relation = 'app.quote_offers'::regclass`,
        );
        waiting = Number(r.rows[0]?.n);
        if (waiting >= expected) break;
        await sleep(50);
      }
      expect(waiting, 'backends waiting on the lock').toBeGreaterThanOrEqual(expected);
      await holder.query('COMMIT');
      released = true;
      return await Promise.all(promises);
    } finally {
      if (!released) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  it('core: 20 racing confirms of one quote yield exactly one ticket', async () => {
    const user = await createUser(owner);
    const q = await createQuote(owner, user);
    const results = await withBarrier(N, () =>
      Array.from({ length: N }, () => confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId })),
    );
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_booked')).toHaveLength(N - 1);
    const tickets = results.map((r) => {
      if (r.kind !== 'created' && r.kind !== 'already_booked') throw new Error(`unexpected ${r.kind}`);
      return r.ticket;
    });
    expect(new Set(tickets.map((t) => t.ticketId)).size).toBe(1);
    for (const t of tickets) expect(t).toEqual(tickets[0]);
    expect(await ticketCount(owner, q.quoteId)).toBe(1);
  });

  it('http: 20 racing POSTs yield one 201 and nineteen 200 alreadyBooked', async () => {
    const token = `tok-${randomBytes(16).toString('hex')}`;
    const app = await buildBookingApp({
      pool: booking,
      serviceToken: token,
      allowedPeers: ['127.0.0.1/32', '::1/128'],
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const user = await createUser(owner);
      const q = await createQuote(owner, user);
      const responses = await withBarrier(N, () =>
        Array.from({ length: N }, async (_, i) => {
          const res = await fetch(`http://127.0.0.1:${port}/internal/v1/bookings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ quoteId: q.quoteId, userId: user.userId, requestId: `req-${i}` }),
          });
          return {
            status: res.status,
            body: (await res.json()) as { ticket: { ticketId: string }; alreadyBooked?: true },
          };
        }),
      );
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      const dup = responses.filter((r) => r.status === 200);
      expect(dup).toHaveLength(N - 1);
      for (const r of dup) expect(r.body.alreadyBooked).toBe(true);
      expect(new Set(responses.map((r) => r.body.ticket.ticketId)).size).toBe(1);
      for (const r of responses) expect(r.body.ticket).toEqual(responses[0]?.body.ticket);
      expect(await ticketCount(owner, q.quoteId)).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('many quotes in parallel: each gets exactly one distinct ticket', async () => {
    const user = await createUser(owner);
    const quotes = await Promise.all(Array.from({ length: 10 }, () => createQuote(owner, user)));
    const calls: Promise<{ quoteId: string; r: ConfirmBookingResult }>[] = [];
    for (let rep = 0; rep < 5; rep++) {
      for (const q of quotes) {
        calls.push(
          confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId }).then((r) => ({
            quoteId: q.quoteId,
            r,
          })),
        );
      }
    }
    const all = await Promise.all(calls);
    const ids = new Set<string>();
    for (const q of quotes) {
      const mine = all.filter((x) => x.quoteId === q.quoteId);
      expect(mine).toHaveLength(5);
      expect(mine.filter((x) => x.r.kind === 'created')).toHaveLength(1);
      expect(mine.filter((x) => x.r.kind === 'already_booked')).toHaveLength(4);
      const tids = new Set(
        mine.map((x) => (x.r.kind === 'created' || x.r.kind === 'already_booked' ? x.r.ticket.ticketId : 'bad')),
      );
      expect(tids.size).toBe(1);
      for (const t of tids) ids.add(t);
      expect(await ticketCount(owner, q.quoteId)).toBe(1);
    }
    expect(ids.size).toBe(10);
  });
});
