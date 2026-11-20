// Session API stand-in (A-01 §5.1), built on @fb/platform/fastify so requests are validated by the CONTRACT schemas
// (EmitEventRequest, strict ajv, CT-07) exactly like the gateway will. In-memory state; the harness talks to it over
// real HTTP through HttpSessionApi.
//
// Simulated gateway behaviour:
//   - step 1 schema + run_started consistency (consumedUpToSeq = max(inputSeqs) <= last_user_seq, inputs are user msgs)
//   - step 3 type whitelist (via the schema union: only harness types are accepted)
//   - step 4 fence: f >= current lease:fence:{sid} (read from the shared Redis stand-in), else 409 FENCE_STALE
//   - step 6 idempotency: same key + same canonical payload -> 200 deduplicated, different -> 409 IDEMPOTENCY_CONFLICT
//   - payloads are stored with Postgres-jsonb key order (shorter keys first, then bytewise): messageJson survives only
//     because it is an opaque string (D-54) — the golden test relies on this
//   - hands-token: fence check + "session active" (pending input or open run), else 409 SESSION_INACTIVE
import { randomUUID } from 'node:crypto';
import { buildServer, errorEnvelope, type FastifyInstance } from '@fb/platform/fastify';
import {
  canonicalJson,
  EmitEventRequest,
  EVENT_ACTOR,
  userMessageIdempotencyKey,
  type EmitEventRequest as EmitReq,
  type EventType,
  type PayloadOf,
} from '@fb/contracts/server';
import type { Ev } from '../../src/events.ts';
import { fenceKey } from '../../src/lease.ts';
import { computeWork, findOpenRun } from '../../src/work.ts';
import type { FakeRedis } from './redis.ts';

export const SERVICE_TOKEN = 'test-service-token';

/** Postgres jsonb object key order: by key length, then bytewise. */
export function jsonbOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v as object).sort((a, b) => {
    const la = Buffer.byteLength(a);
    const lb = Buffer.byteLength(b);
    return la - lb || Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = jsonbOrder((v as Record<string, unknown>)[k]);
  return out;
}

interface SessionState {
  locale: 'zh' | 'en';
  events: Ev[];
  idem: Map<string, { seq: number; id: string; canon: string }>;
}

export class FakeSessionApi {
  readonly sessions = new Map<string, SessionState>();
  /** emits accepted per request (for assertions) */
  readonly emitLog: { sid: string; fence: number; type: string; key: string; status: number }[] = [];
  /** test hook: return a status to inject instead of handling the request */
  inject?: (req: EmitReq, fence: number) => number | undefined;
  app!: FastifyInstance;
  baseUrl = '';
  private readonly redis: FakeRedis;
  private clock = Date.parse('2026-11-19T08:00:00.000Z');

  constructor(redis: FakeRedis) {
    this.redis = redis;
  }

  /** Deterministic timestamps: +1s per event. */
  private ts(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  async start(): Promise<void> {
    this.app = await buildServer({
      allowedPeers: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
      bodyLimit: 64 * 1024,
      routes: (a) => {
        a.addHook('preHandler', async (req, reply) => {
          if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
            return reply.code(401).send(errorEnvelope('SERVICE_AUTH_INVALID', 'bad token', req.trace.traceId));
          }
          return undefined;
        });
        a.get<{ Params: { id: string } }>('/internal/v1/sessions/:id', async (req, reply) => {
          const s = this.sessions.get(req.params.id);
          if (!s) return reply.code(404).send(errorEnvelope('SESSION_NOT_FOUND', 'no session', req.trace.traceId));
          return { id: req.params.id, locale: s.locale, lastSeq: s.events.length };
        });
        a.get<{ Params: { id: string }; Querystring: { afterSeq?: string; limit?: string } }>(
          '/internal/v1/sessions/:id/events',
          async (req, reply) => {
            const s = this.sessions.get(req.params.id);
            if (!s) return reply.code(404).send(errorEnvelope('SESSION_NOT_FOUND', 'no session', req.trace.traceId));
            const after = Number(req.query.afterSeq ?? '0');
            const limit = Math.min(500, Number(req.query.limit ?? '500'));
            const rest = s.events.filter((e) => e.seq > after);
            return { events: rest.slice(0, limit), hasMore: rest.length > limit };
          },
        );
        a.post<{ Params: { id: string }; Body: EmitReq }>(
          '/internal/v1/sessions/:id/events',
          { schema: { body: EmitEventRequest } },
          async (req, reply) => {
            const fence = Number(req.headers['x-lease-fence']);
            const r = this.emit(req.params.id, fence, req.body);
            this.emitLog.push({
              sid: req.params.id,
              fence,
              type: req.body.type,
              key: req.body.idempotencyKey,
              status: r.status,
            });
            if (r.status >= 400)
              return reply.code(r.status).send(errorEnvelope(r.code as never, r.code ?? '', req.trace.traceId));
            return reply.code(r.status).send(r.body);
          },
        );
        a.post<{ Params: { id: string } }>('/internal/v1/sessions/:id/hands-token', async (req, reply) => {
          const sid = req.params.id;
          const s = this.sessions.get(sid);
          if (!s) return reply.code(404).send(errorEnvelope('SESSION_NOT_FOUND', 'no session', req.trace.traceId));
          if (!this.fenceOk(sid, Number(req.headers['x-lease-fence']))) {
            return reply.code(409).send(errorEnvelope('FENCE_STALE', 'stale', req.trace.traceId));
          }
          if (computeWork(s.events).kind === 'none' && findOpenRun(s.events) === undefined) {
            return reply.code(409).send(errorEnvelope('SESSION_INACTIVE', 'inactive', req.trace.traceId));
          }
          return { token: `hands-token:${sid}`, expiresAt: new Date(this.clock + 300_000).toISOString() };
        });
      },
    });
    await this.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = this.app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await this.app?.close();
  }

  createSession(locale: 'zh' | 'en' = 'zh'): string {
    const sid = randomUUID();
    this.sessions.set(sid, { locale, events: [], idem: new Map() });
    return sid;
  }

  events(sid: string): Ev[] {
    return (this.sessions.get(sid) as SessionState).events;
  }

  private append<T extends EventType>(sid: string, type: T, payload: PayloadOf<T>, key: string): Ev {
    const s = this.sessions.get(sid) as SessionState;
    const e = {
      id: randomUUID(),
      sessionId: sid,
      seq: s.events.length + 1,
      type,
      actor: EVENT_ACTOR[type],
      ts: this.ts(),
      traceId: '0af7651916cd43dd8448eb211c80319c',
      idempotencyKey: key,
      schemaVersion: 1,
      payload: jsonbOrder(payload),
    } as unknown as Ev;
    s.events.push(e);
    s.idem.set(key, { seq: e.seq, id: e.id, canon: canonicalJson({ type, payload }) });
    return e;
  }

  /** gateway writes user.message (escaped per A-01 R-7 is not simulated: the projector escapes again) */
  addUserMessage(sid: string, text: string): number {
    const cid = randomUUID();
    return this.append(sid, 'user.message', { text, clientMessageId: cid }, userMessageIdempotencyKey(cid)).seq;
  }

  addBookingConfirmed(sid: string, p: PayloadOf<'booking.confirmed'>): number {
    return this.append(sid, 'booking.confirmed', p, `booking:${p.quoteId}`).seq;
  }

  private fenceOk(sid: string, f: number): boolean {
    const cur = Number(this.redis.get(fenceKey(sid)) ?? '0');
    return Number.isInteger(f) && f >= cur;
  }

  private emit(sid: string, fence: number, req: EmitReq): { status: number; code?: string; body?: unknown } {
    const s = this.sessions.get(sid);
    if (!s) return { status: 404, code: 'SESSION_NOT_FOUND' };
    const injected = this.inject?.(req, fence);
    if (injected !== undefined) return { status: injected, code: injected === 409 ? 'FENCE_STALE' : 'INTERNAL' };
    if (req.type === 'agent.run_started') {
      const p = req.payload;
      const lastUser = Math.max(0, ...s.events.filter((e) => e.type === 'user.message').map((e) => e.seq));
      const userSeqs = new Set(s.events.filter((e) => e.type === 'user.message').map((e) => e.seq));
      if (
        p.consumedUpToSeq !== Math.max(...p.inputSeqs) ||
        p.consumedUpToSeq > lastUser ||
        !p.inputSeqs.every((q) => userSeqs.has(q))
      ) {
        return { status: 400, code: 'EVENT_INVALID' };
      }
    }
    if (!this.fenceOk(sid, fence)) return { status: 409, code: 'FENCE_STALE' };
    const prev = s.idem.get(req.idempotencyKey);
    if (prev !== undefined) {
      if (prev.canon === canonicalJson({ type: req.type, payload: req.payload })) {
        return { status: 200, body: { seq: prev.seq, id: prev.id, deduplicated: true } };
      }
      return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
    }
    const e = this.append(sid, req.type, req.payload as never, req.idempotencyKey);
    return { status: 201, body: { seq: e.seq, id: e.id } };
  }
}
