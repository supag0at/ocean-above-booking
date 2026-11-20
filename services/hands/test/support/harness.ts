// Test harness: real Postgres (support/postgres.ts) + hands Fastify instance (inject) + token signing with a
// throw-away Ed25519 key + fixtures written as fb_owner.
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { signHandsToken, newTicketId, ticketNoFromId } from '@fb/contracts/server';
import type { ExecuteResponse } from '@fb/contracts/tools';
import type { Quote } from '@fb/contracts/web';
import type { FastifyInstance } from '@fb/platform/fastify';
import { buildHandsServer, EXECUTE_PATH } from '../../src/server.ts';
import { publicKeyMap } from '../../src/auth.ts';
import { createFakeFlightCore } from '../fakes/flight-core.ts';
import { fakeBuildProfile } from '../fakes/memory.ts';
import { startTestDb, type TestDb } from './postgres.ts';

export interface Harness {
  readonly db: TestDb;
  readonly app: FastifyInstance;
  readonly privateKey: KeyObject;
  /** token for (sid, uid) signed with the trusted key */
  token(sid: string, uid: string, nowSec?: number): string;
  /** creates a user + session (last_user_seq set) and returns ids and a valid token */
  newSession(opts?: { userId?: string; lastUserSeq?: number }): Promise<{ sid: string; uid: string; token: string }>;
  /** raw POST /internal/execute */
  post(token: string | undefined, body: unknown): Promise<{ status: number; json: unknown }>;
  /** POST with a well-formed envelope; returns the 200 body */
  call(
    s: { token: string },
    name: string,
    input: Record<string, unknown>,
    ids?: { toolCallId?: string; runId?: string; inputSeq?: number },
  ): Promise<ExecuteResponse>;
  /** inserts a ticket for a quote that already exists (as fb_owner) */
  issueTicket(quote: Quote, uid: string, sid: string, bookedAt?: string): Promise<string>;
  count(table: string, where?: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export const NOW_SEC = Math.floor(Date.now() / 1000);

export async function startHarness(): Promise<Harness> {
  const db = await startTestDb();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const app = await buildHandsServer({
    pool: db.hands,
    deps: { flightCore: createFakeFlightCore({ dbPath: 'locations.db' }), buildProfile: fakeBuildProfile },
    publicKeys: publicKeyMap([publicKey.export({ type: 'spki', format: 'pem' }).toString()]),
    allowedPeers: ['127.0.0.1/32', '::1/128'],
  });
  const token = (sid: string, uid: string, nowSec = NOW_SEC) => signHandsToken({ sid, uid, nowSec }, privateKey);
  let seq = 0;

  const h: Harness = {
    db,
    app,
    privateKey,
    token,
    async newSession(opts = {}) {
      const uid = opts.userId ?? randomUUID();
      const sid = randomUUID();
      if (opts.userId === undefined) {
        const u = `u${++seq}${uid.slice(0, 6)}`;
        await db.owner.query('INSERT INTO app.users (id, username, username_norm) VALUES ($1, $2, $2)', [uid, u]);
      }
      await db.owner.query('INSERT INTO app.sessions (id, user_id, locale, last_user_seq) VALUES ($1, $2, $3, $4)', [
        sid,
        uid,
        'en',
        opts.lastUserSeq ?? 5,
      ]);
      return { sid, uid, token: token(sid, uid) };
    },
    async post(tok, body) {
      const res = await app.inject({
        method: 'POST',
        url: EXECUTE_PATH,
        headers: tok === undefined ? {} : { authorization: `Bearer ${tok}` },
        payload: body as Record<string, unknown>,
      });
      return { status: res.statusCode, json: res.json() };
    },
    async call(s, name, input, ids = {}) {
      const r = await h.post(s.token, {
        name,
        input,
        toolCallId: ids.toolCallId ?? `call_${randomUUID()}`,
        runId: ids.runId ?? 'run_TEST',
        inputSeq: ids.inputSeq ?? 3,
      });
      if (r.status !== 200) throw new Error(`execute ${name} -> HTTP ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json as ExecuteResponse;
    },
    async issueTicket(quote, uid, sid, bookedAt = new Date().toISOString()) {
      const id = newTicketId();
      await db.owner.query(
        `INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary,
                                  total_distance_km, price_cents, booked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          ticketNoFromId(id),
          uid,
          sid,
          quote.quoteId,
          quote.from,
          quote.to,
          JSON.stringify(quote),
          quote.totalDistanceKm,
          quote.priceCents,
          bookedAt,
        ],
      );
      return id;
    },
    async count(table, where = 'true', params = []) {
      const r = await db.owner.query<{ n: string }>(`SELECT count(*) AS n FROM app.${table} WHERE ${where}`, params);
      return Number(r.rows[0]?.n ?? 0);
    },
    async close() {
      await app.close();
      await db.stop();
    },
  };
  return h;
}
