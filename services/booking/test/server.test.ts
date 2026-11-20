import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { newQuoteId } from '@fb/contracts/server';
import type { FastifyInstance } from '@fb/platform/fastify';
import { createPgPool, type Pool } from '@fb/platform/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBookingApp } from '../src/server.ts';
import { createQuote, createUser, DATA_SHA256, ticketCount } from './support/fixtures.ts';
import { CONTAINER_HOOK_TIMEOUT_MS, dockerSocket, startPgContainer, type PgContainer } from './support/pg-container.ts';

const dockerOk = (await dockerSocket()) !== null;
const URL = '/internal/v1/bookings';

interface Envelope {
  error: { code: string; message: string; traceId: string; details?: unknown };
}

describe.skipIf(!dockerOk)('booking HTTP API', () => {
  let pg: PgContainer;
  let owner: Pool;
  let booking: Pool;
  let app: FastifyInstance;
  const token = `tok-${randomBytes(16).toString('hex')}`;
  const auth = { authorization: `Bearer ${token}` };

  beforeAll(async () => {
    pg = await startPgContainer('fb-t07-http');
    owner = pg.pool('fb_owner');
    booking = pg.pool('fb_booking');
    app = await buildBookingApp({ pool: booking, serviceToken: token, allowedPeers: ['127.0.0.1/32'] });
  }, CONTAINER_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await app?.close();
    await booking?.end();
    await owner?.end();
    await pg?.stop();
  });

  const post = (
    body: unknown,
    opts: { headers?: Record<string, string>; remoteAddress?: string; target?: FastifyInstance } = {},
  ) =>
    (opts.target ?? app).inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? auth) },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
      ...(opts.remoteAddress !== undefined ? { remoteAddress: opts.remoteAddress } : {}),
    });

  const setup = async (opts: { offered?: boolean } = {}) => {
    const user = await createUser(owner);
    const q = await createQuote(owner, user, opts);
    return { user, q, body: { quoteId: q.quoteId, userId: user.userId, requestId: `req-${randomUUID()}` } };
  };

  const expectError = (res: { statusCode: number; body: string }, status: number, code: string) => {
    expect(res.statusCode).toBe(status);
    const e = JSON.parse(res.body) as Envelope;
    expect(Object.keys(e)).toEqual(['error']);
    expect(e.error.code).toBe(code);
    expect(typeof e.error.message).toBe('string');
    expect(e.error.traceId).toMatch(/^[0-9a-f]{32}$/);
    return e;
  };

  describe('success paths', () => {
    it('201 then 200 alreadyBooked with exact body keys', async () => {
      const { q, body } = await setup();
      const first = await post(body);
      expect(first.statusCode).toBe(201);
      const f = JSON.parse(first.body) as { ticket: { quoteId: string } };
      expect(Object.keys(f)).toEqual(['ticket']);
      expect(f.ticket.quoteId).toBe(q.quoteId);

      const second = await post({ ...body, requestId: 'another-request' });
      expect(second.statusCode).toBe(200);
      const s = JSON.parse(second.body) as { ticket: unknown; alreadyBooked: boolean };
      expect(Object.keys(s).sort()).toEqual(['alreadyBooked', 'ticket']);
      expect(s.alreadyBooked).toBe(true);
      expect(s.ticket).toEqual(f.ticket);
      expect(await ticketCount(owner, q.quoteId)).toBe(1);
    });
  });

  describe('domain errors', () => {
    it("404 QUOTE_NOT_FOUND for someone else's quote and for a nonexistent quote", async () => {
      const { q } = await setup();
      const other = await createUser(owner);
      expectError(await post({ quoteId: q.quoteId, userId: other.userId, requestId: 'r' }), 404, 'QUOTE_NOT_FOUND');
      expectError(await post({ quoteId: newQuoteId(), userId: other.userId, requestId: 'r' }), 404, 'QUOTE_NOT_FOUND');
      expect(await ticketCount(owner, q.quoteId)).toBe(0);
    });

    it('409 QUOTE_NOT_OFFERED', async () => {
      const { q, body } = await setup({ offered: false });
      expectError(await post(body), 409, 'QUOTE_NOT_OFFERED');
      expect(await ticketCount(owner, q.quoteId)).toBe(0);
    });
  });

  describe('401 SERVICE_AUTH_INVALID', () => {
    const cases: [string, Record<string, string>][] = [
      ['no Authorization header', { 'content-type': 'application/json' }],
      ['wrong token', { authorization: 'Bearer nope' }],
      ['Basic scheme', { authorization: `Basic ${token}` }],
      ['Bearer with empty token', { authorization: 'Bearer ' }],
      ['token with extra suffix', { authorization: `Bearer ${token}x` }],
    ];
    it.each(cases)('%s', async (_name, headers) => {
      const { q, body } = await setup();
      expectError(
        await post(body, { headers: { 'content-type': 'application/json', ...headers } }),
        401,
        'SERVICE_AUTH_INVALID',
      );
      expect(await ticketCount(owner, q.quoteId)).toBe(0);
    });

    it('wins over an invalid body', async () => {
      expectError(await post({ garbage: true }, { headers: {} }), 401, 'SERVICE_AUTH_INVALID');
      expectError(
        await post('{not json', { headers: { 'content-type': 'application/json' } }),
        401,
        'SERVICE_AUTH_INVALID',
      );
    });
  });

  describe('403 FORBIDDEN_PEER', () => {
    it.each(['172.30.2.130', '10.0.0.5'])('rejects peer %s even with a correct token', async (remoteAddress) => {
      const { q, body } = await setup();
      expectError(await post(body, { remoteAddress }), 403, 'FORBIDDEN_PEER');
      expect(await ticketCount(owner, q.quoteId)).toBe(0);
    });

    it('peer check precedes auth', async () => {
      const { body } = await setup();
      expectError(await post(body, { headers: {}, remoteAddress: '10.0.0.5' }), 403, 'FORBIDDEN_PEER');
    });

    it('gateway peer is allowed', async () => {
      const gw = await buildBookingApp({ pool: booking, serviceToken: token, allowedPeers: ['172.30.3.20/32'] });
      try {
        const { q, body } = await setup();
        const res = await post(body, { target: gw, remoteAddress: '172.30.3.20' });
        expect(res.statusCode).toBe(201);
        expect(await ticketCount(owner, q.quoteId)).toBe(1);
        // and the default inject peer (127.0.0.1) is not
        expectError(await post(body, { target: gw }), 403, 'FORBIDDEN_PEER');
      } finally {
        await gw.close();
      }
    });
  });

  describe('400 VALIDATION_FAILED', () => {
    it.each<[string, (b: Record<string, unknown>) => Record<string, unknown>]>([
      ['extra field sessionId', (b) => ({ ...b, sessionId: randomUUID() })],
      ['missing requestId', (b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'requestId'))],
      ['quoteId wrong pattern', (b) => ({ ...b, quoteId: 'q_lowercase' })],
      ['userId not a uuid', (b) => ({ ...b, userId: 'not-a-uuid' })],
      ['userId a number', (b) => ({ ...b, userId: 42 })],
      ['empty requestId', (b) => ({ ...b, requestId: '' })],
    ])('%s', async (_name, mutate) => {
      const { q, body } = await setup();
      expectError(await post(mutate(body)), 400, 'VALIDATION_FAILED');
      expect(await ticketCount(owner, q.quoteId)).toBe(0);
    });
  });

  describe('health', () => {
    it('/healthz and /readyz 200 with a live pool', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    });
  });

  describe('dead database', () => {
    it('/readyz and POST both answer 503 SERVICE_UNAVAILABLE', async () => {
      const port = await new Promise<number>((resolve, reject) => {
        const s = createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
      const dead = createPgPool({
        host: '127.0.0.1',
        port,
        database: 'app',
        user: 'fb_booking',
        secrets: { get: () => 'x' },
        connectionTimeoutMs: 500,
      });
      const deadApp = await buildBookingApp({ pool: dead, serviceToken: token, allowedPeers: ['127.0.0.1/32'] });
      try {
        expectError(await deadApp.inject({ method: 'GET', url: '/readyz' }), 503, 'SERVICE_UNAVAILABLE');
        expectError(
          await post({ quoteId: newQuoteId(), userId: randomUUID(), requestId: 'r' }, { target: deadApp }),
          503,
          'SERVICE_UNAVAILABLE',
        );
      } finally {
        await deadApp.close();
        await dead.end();
      }
    });
  });

  describe('500 INTERNAL', () => {
    it('corrupt quote payload gives 500 without leaking internals', async () => {
      const user = await createUser(owner);
      const id = newQuoteId();
      const payload = { quoteId: newQuoteId(), totalDistanceKm: 1, priceCents: 1 };
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
      const res = await post({ quoteId: id, userId: user.userId, requestId: 'r' });
      const e = expectError(res, 500, 'INTERNAL');
      expect(e.error.message).toBe('internal error');
      expect(res.body).not.toContain('payload');
      expect(res.body).not.toContain(id);
      expect(await ticketCount(owner, id)).toBe(0);
    });
  });
});
