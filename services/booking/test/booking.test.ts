import { randomUUID } from 'node:crypto';
import { newQuoteId, newTicketId } from '@fb/contracts/server';
import type { Pool } from '@fb/platform/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingInvariantError, confirmBooking } from '../src/booking.ts';
import { createQuote, createUser, DATA_SHA256, ticketCount } from './support/fixtures.ts';
import { CONTAINER_HOOK_TIMEOUT_MS, dockerSocket, startPgContainer, type PgContainer } from './support/pg-container.ts';

const dockerOk = (await dockerSocket()) !== null;

describe.skipIf(!dockerOk)('confirmBooking (fb_booking against real postgres)', () => {
  let pg: PgContainer;
  let owner: Pool;
  let booking: Pool;

  beforeAll(async () => {
    pg = await startPgContainer('fb-t07-core');
    owner = pg.pool('fb_owner');
    booking = pg.pool('fb_booking');
  }, CONTAINER_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await booking?.end();
    await owner?.end();
    await pg?.stop();
  });

  const eventCount = async (): Promise<number> =>
    Number((await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM app.events')).rows[0]?.n);

  it('creates a ticket that copies the quote', async () => {
    const user = await createUser(owner);
    const q = await createQuote(owner, user);
    const before = await eventCount();
    const r = await confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const t = r.ticket;
    expect(t.ticketId).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(t.ticketNo).toBe(`OA-${t.ticketId.slice(-8)}`);
    expect(t.quoteId).toBe(q.quoteId);
    expect(t.sessionId).toBe(user.sessionId);
    expect(t.from).toBe('San José');
    expect(t.to).toBe('Reykjavík');
    expect(t.from).toBe(q.payload.from);
    expect(t.to).toBe(q.payload.to);
    expect(t.priceCents).toBe(q.payload.priceCents);
    expect(t.itinerary).toEqual(q.payload);
    expect(new Date(t.bookedAt).toISOString()).toBe(t.bookedAt);

    const row = (
      await owner.query<{
        total_distance_km: number;
        price_cents: number;
        user_id: string;
        status: string;
      }>('SELECT total_distance_km, price_cents, user_id, status FROM app.tickets WHERE id = $1', [t.ticketId])
    ).rows[0];
    expect(row).toBeDefined();
    expect(Number(row?.total_distance_km)).toBe(q.payload.totalDistanceKm);
    expect(row?.price_cents).toBe(q.payload.priceCents);
    expect(row?.user_id).toBe(user.userId);
    expect(row?.status).toBe('issued');
    expect(await eventCount()).toBe(before);
  });

  it('is idempotent for the same user', async () => {
    const user = await createUser(owner);
    const q = await createQuote(owner, user);
    const first = await confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId });
    const second = await confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('already_booked');
    if (first.kind === 'created' && second.kind === 'already_booked') expect(second.ticket).toEqual(first.ticket);
    expect(await ticketCount(owner, q.quoteId)).toBe(1);
  });

  it("does not let another user book or see someone else's quote", async () => {
    const a = await createUser(owner);
    const b = await createUser(owner);
    const q = await createQuote(owner, a);
    expect(await confirmBooking(booking, { quoteId: q.quoteId, userId: b.userId })).toEqual({ kind: 'not_found' });
    expect(await ticketCount(owner, q.quoteId)).toBe(0);
    expect((await confirmBooking(booking, { quoteId: q.quoteId, userId: a.userId })).kind).toBe('created');
    expect(await confirmBooking(booking, { quoteId: q.quoteId, userId: b.userId })).toEqual({ kind: 'not_found' });
    expect(await ticketCount(owner, q.quoteId)).toBe(1);
  });

  it('not_found for a nonexistent quote', async () => {
    const user = await createUser(owner);
    expect(await confirmBooking(booking, { quoteId: newQuoteId(), userId: user.userId })).toEqual({
      kind: 'not_found',
    });
  });

  it('not_offered when the quote was never offered', async () => {
    const user = await createUser(owner);
    const q = await createQuote(owner, user, { offered: false });
    expect(await confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId })).toEqual({
      kind: 'not_offered',
    });
    expect(await ticketCount(owner, q.quoteId)).toBe(0);
  });

  it('not_offered when the quote was offered only in a different session', async () => {
    const user = await createUser(owner);
    const other = await createUser(owner);
    const q = await createQuote(owner, user, { offerSessionId: other.sessionId });
    expect(await confirmBooking(booking, { quoteId: q.quoteId, userId: user.userId })).toEqual({
      kind: 'not_offered',
    });
    expect(await ticketCount(owner, q.quoteId)).toBe(0);
  });

  describe('ticket id collision (S-13)', () => {
    it('retries with a fresh id', async () => {
      const user = await createUser(owner);
      const q1 = await createQuote(owner, user);
      const q2 = await createQuote(owner, user);
      const r1 = await confirmBooking(booking, { quoteId: q1.quoteId, userId: user.userId });
      if (r1.kind !== 'created') throw new Error('setup');
      const t1 = r1.ticket.ticketId;
      const fresh = newTicketId();
      const ids = [t1, fresh];
      let calls = 0;
      const r2 = await confirmBooking(
        booking,
        { quoteId: q2.quoteId, userId: user.userId },
        { newTicketId: () => ids[calls++] ?? newTicketId() },
      );
      expect(r2.kind).toBe('created');
      if (r2.kind === 'created') expect(r2.ticket.ticketId).toBe(fresh);
      expect(calls).toBe(2);
      expect(await ticketCount(owner, q2.quoteId)).toBe(1);
    });

    it('gives up after MAX attempts with 23505 and rolls back; pool stays usable', async () => {
      const user = await createUser(owner);
      const q1 = await createQuote(owner, user);
      const q2 = await createQuote(owner, user);
      const r1 = await confirmBooking(booking, { quoteId: q1.quoteId, userId: user.userId });
      if (r1.kind !== 'created') throw new Error('setup');
      const t1 = r1.ticket.ticketId;
      await expect(
        confirmBooking(booking, { quoteId: q2.quoteId, userId: user.userId }, { newTicketId: () => t1 }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(await ticketCount(owner, q2.quoteId)).toBe(0);
      const r2 = await confirmBooking(booking, { quoteId: q2.quoteId, userId: user.userId });
      expect(r2.kind).toBe('created');
      expect(await ticketCount(owner, q2.quoteId)).toBe(1);
    });
  });

  describe('corrupt quote payloads', () => {
    const insertCorrupt = async (mutate: (p: Record<string, unknown>) => void) => {
      const user = await createUser(owner);
      const id = newQuoteId();
      const payload: Record<string, unknown> = {
        quoteId: id,
        from: 'A',
        to: 'B',
        totalDistanceKm: 10,
        priceCents: 100,
      };
      mutate(payload);
      await owner.query(
        `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload)
         VALUES ($1, $2, $3, 'A', 'B', $4, $5)`,
        [id, user.userId, user.sessionId, DATA_SHA256, JSON.stringify(payload)],
      );
      await owner.query('INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ($1, $2, $3)', [
        id,
        user.sessionId,
        `call_${randomUUID()}`,
      ]);
      return { id, user };
    };

    it('rejects when payload.quoteId differs from the id', async () => {
      const { id, user } = await insertCorrupt((p) => {
        p.quoteId = newQuoteId();
      });
      await expect(confirmBooking(booking, { quoteId: id, userId: user.userId })).rejects.toBeInstanceOf(
        BookingInvariantError,
      );
      expect(await ticketCount(owner, id)).toBe(0);
    });

    it('rejects when priceCents is a string', async () => {
      const { id, user } = await insertCorrupt((p) => {
        p.priceCents = '100';
      });
      await expect(confirmBooking(booking, { quoteId: id, userId: user.userId })).rejects.toBeInstanceOf(
        BookingInvariantError,
      );
      expect(await ticketCount(owner, id)).toBe(0);
    });
  });

  describe('events are not booking to write (M-21)', () => {
    it('fb_booking has no grant on app.events', async () => {
      await expect(booking.query('SELECT count(*) FROM app.events')).rejects.toMatchObject({ code: '42501' });
      const user = await createUser(owner);
      await expect(
        booking.query(
          `INSERT INTO app.events (session_id, seq, type, actor, trace_id, idempotency_key, payload)
           VALUES ($1, 1, 'booking.confirmed', 'system', 't', 'k', '{}')`,
          [user.sessionId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
