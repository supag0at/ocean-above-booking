// Fixture rows, written as fb_owner (what hands / gateway would have written). booking itself only reads them.
import { randomUUID } from 'node:crypto';
import { newQuoteId } from '@fb/contracts/server';
import type { Quote } from '@fb/contracts/web';
import type { Pool } from '@fb/platform/pg';

export const DATA_SHA256 = 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f';

export interface UserFixture {
  readonly userId: string;
  readonly sessionId: string;
}

export async function createUser(owner: Pool, username = `u${randomUUID().slice(0, 8)}`): Promise<UserFixture> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await owner.query('INSERT INTO app.users (id, username, username_norm, locale) VALUES ($1, $2, $3, $4)', [
    userId,
    username,
    username.toLowerCase(),
    'en',
  ]);
  await owner.query('INSERT INTO app.sessions (id, user_id, locale) VALUES ($1, $2, $3)', [sessionId, userId, 'en']);
  return { userId, sessionId };
}

/** A two-leg quote; numbers are fixed literals (booking must copy them, never recompute). */
export function quotePayload(quoteId: string): Quote {
  return {
    quoteId,
    from: 'San José',
    to: 'Reykjavík',
    legs: [
      { from: 'San José', to: 'Ørland', distanceKm: 8123.456789 },
      { from: 'Ørland', to: 'Reykjavík', distanceKm: 1500.5 },
    ],
    transferCities: ['Ørland'],
    totalDistanceKm: 9623.956789,
    priceCents: 125111,
    display: {
      legs: ['San José → Ørland', 'Ørland → Reykjavík'],
      totalDistanceKm: '9,623.96 km',
      priceUsd: '$1,251.11',
    },
    dataSha256: DATA_SHA256,
    createdAt: '2026-11-19T00:00:00.000Z',
  };
}

export interface QuoteFixture {
  readonly quoteId: string;
  readonly payload: Quote;
}

/** Inserts a quote for `user` in the user's session; `offered` adds a quote_offers row in that same session. */
export async function createQuote(
  owner: Pool,
  user: UserFixture,
  opts: { offered?: boolean; offerSessionId?: string } = {},
): Promise<QuoteFixture> {
  const quoteId = newQuoteId();
  const payload = quotePayload(quoteId);
  await owner.query(
    `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [quoteId, user.userId, user.sessionId, payload.from, payload.to, DATA_SHA256, JSON.stringify(payload)],
  );
  if (opts.offered !== false) {
    await owner.query('INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ($1, $2, $3)', [
      quoteId,
      opts.offerSessionId ?? user.sessionId,
      `call_${randomUUID()}`,
    ]);
  }
  return { quoteId, payload };
}

export async function ticketCount(owner: Pool, quoteId: string): Promise<number> {
  const r = await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM app.tickets WHERE quote_id = $1', [
    quoteId,
  ]);
  return Number(r.rows[0]?.n ?? '0');
}
