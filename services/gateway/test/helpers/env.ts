// Integration environment for T06: real Postgres 16 (initialised by infra/db/init/00-roles.sh, i.e. the real
// migrations + grants) and real Redis 7 with the A-01 §7.2 ACL, both in throw-away containers via the Docker Engine
// API; a fake booking service on 127.0.0.1 implementing the booking API contract (A-01 §5.4) against the real
// tables as fb_owner (test fixture only; the gateway itself runs as fb_gateway).
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CreateBookingRequest, newQuoteId, newTicketId, ticketNoFromId } from '@fb/contracts/server';
import { createHttpClient, type HttpClient } from '@fb/platform/http';
import { createLogger, type Logger } from '@fb/platform/log';
import { createPgPool, type Pool } from '@fb/platform/pg';
import { createRedis, type Redis } from '@fb/platform/redis';
import type { SecretProvider } from '@fb/platform/secrets';
import { buildGateway, type Gateway } from '../../src/app.ts';
import type { Doorbell } from '../../src/doorbell.ts';
import { gatewayAclRule } from '../../src/redis-acl.ts';
import { check } from '../../src/validate.ts';
import { dockerAvailable, imagePresent, runContainer, type Container } from './docker.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const INFRA_DB = join(ROOT, 'infra', 'db');
export const ORIGIN = 'http://ocean.test';
export const HARNESS_TOKEN = randomBytes(24).toString('base64url');
export const BOOKING_TOKEN = randomBytes(24).toString('base64url');

/** Why integration tests are skipped, or null when they can run. Printed by the test files. */
export async function skipReason(): Promise<string | null> {
  if (!(await dockerAvailable())) return 'Docker Engine is not reachable (is Docker Desktop running?)';
  for (const img of ['postgres:16', 'redis:7']) if (!(await imagePresent(img))) return `image ${img} is not pulled`;
  return null;
}

const secretsOf = (v: string): SecretProvider => ({ get: () => v });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RingRecord {
  readonly sessionId: string;
  readonly jobId: string;
}

export interface FakeBooking {
  readonly url: string;
  /**
   * normal: A-01 §5.2 a–d; down: 503; commit-then-500: issues the ticket then answers 500 (gateway crash / lost
   * reply); hang: never answers (gateway timeout); reply: always answers `reply` verbatim.
   */
  mode: 'normal' | 'down' | 'commit-then-500' | 'hang' | 'reply';
  reply?: { status: number; body: unknown };
  calls: number;
  /** every request as received (headers lower-cased, body parsed) */
  readonly requests: { headers: Record<string, string | string[] | undefined>; body: unknown }[];
}

export interface Env {
  readonly owner: Pool;
  readonly gwPool: Pool;
  readonly redis: Redis;
  /** harness-ACL connection (INCR fence, PUBLISH ephemeral) */
  readonly harnessRedis: Redis;
  /** test-only superuser connection (FLUSHALL, ACL LOG, queue inspection) */
  readonly admin: Redis;
  /** a fresh connection as the harness ACL user (e.g. for a BullMQ worker: `{ maxRetriesPerRequest: null }`) */
  harnessConnection(extra?: Record<string, unknown>): Redis;
  /** sessions whose post-message doorbell is lost (ringForMessage fails as if Redis refused it) */
  readonly dropDoorbell: Set<string>;
  /** Redis ACL LOG entries (`user: reason object`) since startup; must stay empty for the gateway user */
  aclDenials(): Promise<string[]>;
  readonly gw: Gateway;
  readonly rings: RingRecord[];
  readonly booking: FakeBooking;
  readonly publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  /** real BullMQ doorbell over the gateway ACL (used to prove the ACL + jobId format work) */
  readonly realDoorbell: Doorbell;
  readonly log: Logger;
  readonly logLines: string[];
  close(): Promise<void>;
}

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function startEnv(): Promise<Env> {
  const tag = randomBytes(4).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'fb-t06-'));
  const pw = Object.fromEntries(
    ['superuser', 'owner', 'gateway', 'hands', 'booking'].map((r) => [r, `pw${randomBytes(12).toString('hex')}`]),
  ) as Record<string, string>;
  for (const [r, v] of Object.entries(pw)) writeFileSync(join(dir, `pg_${r}_password`), `${v}\n`);
  const redisPw = {
    gateway: `rg${randomBytes(12).toString('hex')}`,
    harness: `rh${randomBytes(12).toString('hex')}`,
    admin: `ra${randomBytes(12).toString('hex')}`,
  };
  writeFileSync(
    join(dir, 'users.acl'),
    [
      'user default off',
      // the narrowed gateway rule (src/redis-acl.ts); denials show up in ACL LOG (Env.aclDenials)
      gatewayAclRule(sha(redisPw.gateway)),
      // harness: A-01 §7.2 as written + `+info` (BullMQ workers run INFO on connect); only INCR/PUBLISH used here
      `user harness on #${sha(redisPw.harness)} ~bull:harness-wake:* ~lease:* &sse:* +@read +@write +@pubsub +@scripting +@transaction +@connection +@blocking -@dangerous +info`,
      // test-only admin: FLUSHALL (Redis data-loss scenario), ACL LOG, queue inspection
      `user admin on #${sha(redisPw.admin)} ~* &* +@all`,
      '',
    ].join('\n'),
  );

  const containers: Container[] = [];
  const pg = await runContainer({
    image: 'postgres:16',
    name: `fb-t06-pg-${tag}`,
    port: '5432/tcp',
    env: {
      POSTGRES_DB: 'app',
      POSTGRES_PASSWORD_FILE: '/run/secrets/pg_superuser_password',
      INFRA_DB_DIR: '/infra-db',
    },
    binds: [
      `${dir}:/run/secrets:ro`,
      `${INFRA_DB}:/infra-db:ro`,
      `${join(INFRA_DB, 'init', '00-roles.sh')}:/docker-entrypoint-initdb.d/00-roles.sh:ro`,
    ],
  });
  containers.push(pg);
  const rd = await runContainer({
    image: 'redis:7',
    name: `fb-t06-redis-${tag}`,
    port: '6379/tcp',
    binds: [`${dir}:/acl:ro`],
    cmd: ['redis-server', '--aclfile', '/acl/users.acl', '--save', '', '--appendonly', 'no'],
  });
  containers.push(rd);

  const cleanup = async (): Promise<void> => {
    for (const c of containers) await c.remove().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitFor(async () => (await pg.logs()).includes('PostgreSQL init process complete'), 90_000, 'postgres init');
    const mkPool = (user: string, pass: string): Pool =>
      createPgPool({ host: '127.0.0.1', port: pg.hostPort, database: 'app', user, secrets: secretsOf(pass), max: 10 });
    const owner = mkPool('fb_owner', pw.owner!);
    await waitFor(async () => (await owner.query('SELECT 1')).rowCount === 1, 30_000, 'postgres ready');
    const gwPool = mkPool('fb_gateway', pw.gateway!);

    const mkRedis = (user: string, pass: string, extra: Record<string, unknown> = {}): Redis =>
      createRedis({ host: '127.0.0.1', port: rd.hostPort, username: user, secrets: secretsOf(pass), ...extra });
    // same options as main.ts
    const redis = mkRedis('gateway', redisPw.gateway, { connectionName: 'gateway' });
    await waitFor(async () => (await redis.ping()) === 'PONG', 30_000, 'redis ready');
    const subscriber = mkRedis('gateway', redisPw.gateway, { connectionName: 'gateway-sse', commandTimeoutMs: 5000 });
    const queueConnection = mkRedis('gateway', redisPw.gateway, {
      connectionName: 'gateway-wake',
      maxRetriesPerRequest: null,
    });
    const harnessRedis = mkRedis('harness', redisPw.harness);
    const admin = mkRedis('admin', redisPw.admin);
    await admin.call('ACL', 'LOG', 'RESET');

    const booking = await startFakeBooking(owner);
    // as main.ts builds it: Bearer booking_service_token on every call
    const bookingClient: HttpClient = createHttpClient({
      baseUrl: booking.url,
      retries: 0,
      timeoutMs: 5000,
      headers: { authorization: `Bearer ${BOOKING_TOKEN}` },
    });

    const logLines: string[] = [];
    const log = createLogger({
      service: 'gateway-test',
      level: 'debug',
      destination: { write: (l) => logLines.push(l) },
    });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');

    const { createDoorbell } = await import('../../src/doorbell.ts');
    const realDoorbell = createDoorbell(queueConnection, log);
    const rings: RingRecord[] = [];
    const dropDoorbell = new Set<string>();
    const extraConnections: Redis[] = [];
    const doorbell: Doorbell = {
      ringForMessage: async (sessionId, seq, tp) => {
        rings.push({ sessionId, jobId: `wake-${sessionId}-${seq}` });
        if (dropDoorbell.has(sessionId)) return false;
        return realDoorbell.ringForMessage(sessionId, seq, tp);
      },
      ringForSweep: async (sessionId, epochMs, tp) => {
        const { sweeperWakeJobId } = await import('@fb/contracts/server');
        rings.push({ sessionId, jobId: sweeperWakeJobId(sessionId, epochMs) });
        return realDoorbell.ringForSweep(sessionId, epochMs, tp);
      },
      close: () => realDoorbell.close(),
    };

    const gw = await buildGateway({
      pool: gwPool,
      redis,
      subscriber,
      queueConnection,
      log,
      booking: bookingClient,
      handsTokenKey: privateKey,
      harnessServiceToken: HARNESS_TOKEN,
      cookieSecret: randomBytes(32).toString('hex'),
      publicOrigin: ORIGIN,
      cookieSecure: false,
      agentDeltaMode: 'stream',
      publicAllowedPeers: ['127.0.0.1', '::1'],
      internalAllowedPeers: ['127.0.0.1', '::1'],
      sseHeartbeatMs: 60_000,
      doorbell,
    });

    return {
      owner,
      gwPool,
      redis,
      harnessRedis,
      admin,
      harnessConnection(extra = {}) {
        const r = mkRedis('harness', redisPw.harness, extra);
        extraConnections.push(r);
        return r;
      },
      dropDoorbell,
      gw,
      rings,
      booking,
      publicKey,
      realDoorbell,
      log,
      logLines,
      async aclDenials() {
        const entries = (await admin.call('ACL', 'LOG')) as unknown[][];
        return entries.map((e) => {
          const m = new Map<string, unknown>();
          for (let i = 0; i + 1 < e.length; i += 2) m.set(String(e[i]), e[i + 1]);
          return `${String(m.get('username'))}: ${String(m.get('reason'))} ${String(m.get('object'))}`;
        });
      },
      async close() {
        await gw.close();
        await bookingClient.close();
        booking.server.close();
        await owner.end();
        await gwPool.end();
        for (const r of [redis, subscriber, queueConnection, harnessRedis, admin, ...extraConnections]) r.disconnect();
        await cleanup();
      },
    };
  } catch (err) {
    const logs = await Promise.all(containers.map((c) => c.logs().catch(() => '')));
    await cleanup();
    const tail = logs.map((l) => l.slice(-1500)).join('\n---\n');
    throw new Error(`${(err as Error).message}\n--- container logs ---\n${tail}`, { cause: err });
  }
}

// ---------- fake booking (A-01 §5.2 a–d, §5.4) ----------
async function startFakeBooking(owner: Pool): Promise<FakeBooking & { server: Server }> {
  const state: FakeBooking & { server?: Server } = { url: '', mode: 'normal', calls: 0, requests: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        state.calls++;
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        const err = (status: number, code: string): void =>
          send(status, { error: { code, message: code, traceId: '0'.repeat(32) } });
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = undefined;
        }
        state.requests.push({ headers: { ...req.headers }, body });
        if (state.mode === 'hang') return; // never answers; the gateway's 5 s timeout fires
        if (state.mode === 'reply' && state.reply) return send(state.reply.status, state.reply.body);
        if (state.mode === 'down') return err(503, 'SERVICE_UNAVAILABLE');
        // T07's contract: Bearer booking_service_token; body exactly { quoteId, userId, requestId } (extra key -> 400)
        if (req.method !== 'POST' || req.url !== '/internal/v1/bookings') return err(404, 'NOT_FOUND');
        if (req.headers.authorization !== `Bearer ${BOOKING_TOKEN}`) return err(401, 'SERVICE_AUTH_INVALID');
        if (!check(CreateBookingRequest, body)) return err(400, 'VALIDATION_FAILED');
        const { quoteId, userId } = body as { quoteId: string; userId: string };
        const c = await owner.connect();
        try {
          await c.query('BEGIN');
          const qr = await c.query('SELECT * FROM app.quotes WHERE id = $1 AND user_id = $2', [quoteId, userId]);
          const quote = qr.rows[0] as Record<string, unknown> | undefined;
          if (!quote) {
            await c.query('ROLLBACK');
            return err(404, 'QUOTE_NOT_FOUND');
          }
          const off = await c.query('SELECT 1 FROM app.quote_offers WHERE quote_id = $1 AND session_id = $2', [
            quoteId,
            quote.session_id,
          ]);
          if (off.rowCount === 0) {
            await c.query('ROLLBACK');
            return err(409, 'QUOTE_NOT_OFFERED');
          }
          const tid = newTicketId();
          const payload = quote.payload as Record<string, unknown>;
          const ins = await c.query(
            `INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary,
                                      total_distance_km, price_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (quote_id) DO NOTHING RETURNING *`,
            [
              tid,
              ticketNoFromId(tid),
              userId,
              quote.session_id,
              quoteId,
              quote.from_city,
              quote.to_city,
              JSON.stringify(payload),
              payload.totalDistanceKm,
              payload.priceCents,
            ],
          );
          let row = ins.rows[0] as Record<string, unknown> | undefined;
          const replay = !row;
          if (!row) row = (await c.query('SELECT * FROM app.tickets WHERE quote_id = $1', [quoteId])).rows[0];
          await c.query('COMMIT');
          if (state.mode === 'commit-then-500') return err(500, 'INTERNAL');
          const r = row as Record<string, unknown>;
          const ticket = {
            ticketId: r.id,
            ticketNo: r.ticket_no,
            sessionId: r.session_id,
            quoteId: r.quote_id,
            from: r.from_city,
            to: r.to_city,
            itinerary: r.itinerary,
            priceCents: r.price_cents,
            bookedAt: (r.booked_at as Date).toISOString(),
          };
          return replay ? send(200, { ticket, alreadyBooked: true }) : send(201, { ticket });
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          return err(500, `INTERNAL ${(e as Error).message}`);
        } finally {
          c.release();
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  state.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  state.server = server;
  return state as FakeBooking & { server: Server };
}

// ---------- fixtures (as fb_owner) ----------
export const DATA_SHA = 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f';

export function quotePayload(quoteId: string, from = 'Oslo', to = 'Lisboa'): Record<string, unknown> {
  return {
    quoteId,
    from,
    to,
    legs: [
      { from, to: 'Paris', distanceKm: 1343.21 },
      { from: 'Paris', to, distanceKm: 1453.07 },
    ],
    transferCities: ['Paris'],
    totalDistanceKm: 2796.28,
    priceCents: 36352,
    display: { legs: ['1343.21', '1453.07'], totalDistanceKm: '2796.28', priceUsd: '363.52' },
    dataSha256: DATA_SHA,
    createdAt: new Date().toISOString(),
  };
}

/** Insert a quote (+ optional offer row) for a session, as hands would. */
export async function seedQuote(
  owner: Pool,
  a: { userId: string; sessionId: string; offered: boolean; toolCallId?: string },
): Promise<string> {
  const id = newQuoteId();
  await owner.query(
    `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload)
     VALUES ($1,$2,$3,'Oslo','Lisboa',$4,$5)`,
    [id, a.userId, a.sessionId, DATA_SHA, JSON.stringify(quotePayload(id))],
  );
  if (a.offered) {
    await owner.query('INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ($1,$2,$3)', [
      id,
      a.sessionId,
      a.toolCallId ?? `tc_${randomUUID()}`,
    ]);
  }
  return id;
}

/**
 * Issue a ticket for a quote directly as fb_owner, as if booking committed and the gateway then crashed before
 * writing booking.confirmed (CONTRACT M-24 ⑥: test fixtures may pre-seed tickets). `ageSeconds` back-dates booked_at.
 */
export async function seedTicket(
  owner: Pool,
  a: { userId: string; sessionId: string; quoteId: string; ageSeconds?: number },
): Promise<string> {
  const tid = newTicketId();
  const p = quotePayload(a.quoteId);
  await owner.query(
    `INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary,
                              total_distance_km, price_cents, booked_at)
     VALUES ($1,$2,$3,$4,$5,'Oslo','Lisboa',$6,$7,$8, now() - make_interval(secs => $9))`,
    [
      tid,
      ticketNoFromId(tid),
      a.userId,
      a.sessionId,
      a.quoteId,
      JSON.stringify(p),
      p.totalDistanceKm,
      p.priceCents,
      a.ageSeconds ?? 0,
    ],
  );
  return tid;
}

export { sleep };
