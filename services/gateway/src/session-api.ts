// Session API on :8081, harness only (A-01 §5.1, §5.3; A-02 §3). Bearer harness_service_token (constant time);
// writes and hands-token requests additionally carry X-Lease-Fence. One event per emit (O-2).
import { timingSafeEqual } from 'node:crypto';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EmitEventRequest,
  GetEventsQuery,
  MAX_EMIT_BODY_BYTES,
  MAX_EVENTS_PAGE,
  SessionParams,
  canWrite,
  type EventType,
} from '@fb/contracts/server';
import { HttpError, type FastifyInstance, type FastifyRequest } from '@fb/platform/fastify';
import { appendEvent, lockSession } from './append.ts';
import type { GatewayContext } from './context.ts';
import { num, q, tx, withUniqueRetry, type PgClient } from './db.ts';
import { checkFence, parseFence } from './fence.ts';
import { check } from './validate.ts';
import { EVENT_COLUMNS, eventRowFromDb } from './views.ts';

const P = '/internal/v1/sessions';
/** route body limit; anything between this and MAX_EMIT_BODY_BYTES is rejected as EVENT_INVALID (A-01 §5.1 step 1) */
export const INTERNAL_BODY_LIMIT = 2 * MAX_EMIT_BODY_BYTES;

// raw request-body size per request (fastify module augmentation is unavailable outside platform)
const RAW_BYTES = new WeakMap<FastifyRequest, number>();

const invalid = (msg: string): HttpError => new HttpError('EVENT_INVALID', msg);

function fenceOf(req: FastifyRequest): number {
  const f = parseFence(req.headers['x-lease-fence']);
  if (f === null) throw new HttpError('VALIDATION_FAILED', 'X-Lease-Fence header must be a non-negative integer');
  return f;
}

async function fenceOk(ctx: GatewayContext, sessionId: string, fence: number, maxFenceSeen: number): Promise<void> {
  let r;
  try {
    r = await checkFence(ctx.redis, sessionId, fence, maxFenceSeen);
  } catch {
    throw new HttpError('SERVICE_UNAVAILABLE', 'fence store unavailable');
  }
  if (r === 'RESET') {
    ctx.log.warn({ sessionId, fence, maxFenceSeen }, 'lease fence below max_fence_seen: Redis lost data, fence raised');
  }
  if (r !== 'OK')
    throw new HttpError('FENCE_STALE', r === 'RESET' ? 'fence reset after Redis data loss' : 'stale fence');
}

/** A-01 §5.1 step 1 (consistency part): consumedUpToSeq = max(inputSeqs) <= last_user_seq, all inputs are user.message. */
async function checkRunStarted(c: PgClient, sessionId: string, lastUserSeq: number, p: Record<string, unknown>) {
  const inputSeqs = p.inputSeqs as number[];
  const upTo = p.consumedUpToSeq as number;
  if (upTo !== Math.max(...inputSeqs)) throw invalid('consumedUpToSeq must equal max(inputSeqs)');
  if (upTo > lastUserSeq) throw invalid('consumedUpToSeq is beyond the last user.message');
  const distinct = [...new Set(inputSeqs)];
  if (distinct.length !== inputSeqs.length) throw invalid('inputSeqs contains duplicates');
  const r = await c.query(
    `SELECT count(*)::int AS n FROM app.events WHERE session_id = $1 AND seq = ANY($2::bigint[]) AND type = 'user.message'`,
    [sessionId, distinct],
  );
  if (num((r.rows[0] as { n: unknown }).n) !== distinct.length) throw invalid('inputSeqs must all be user.message');
}

export function registerSessionApi(app: FastifyInstance, ctx: GatewayContext): void {
  const expected = Buffer.from(ctx.harnessServiceToken);

  // raw byte count for the 64 KB rule; empty body -> undefined (hands-token takes no body)
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    RAW_BYTES.set(req, buf.length);
    if (buf.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buf.toString('utf8')) as unknown);
    } catch {
      done(Object.assign(new Error('malformed JSON body'), { statusCode: 400 }), undefined);
    }
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/internal/')) return;
    const h = req.headers.authorization;
    const token = typeof h === 'string' && h.startsWith('Bearer ') ? Buffer.from(h.slice(7)) : Buffer.alloc(0);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      throw new HttpError('SERVICE_AUTH_INVALID', 'invalid service token');
    }
  });

  // GET /internal/v1/sessions/:id -> { id, locale, lastSeq } (no userId)
  app.get(`${P}/:id`, { schema: { params: SessionParams } }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await q(ctx.pool, 'SELECT id, locale, last_seq FROM app.sessions WHERE id = $1', [id]);
    if (!row) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    return { id: String(row.id), locale: row.locale === 'en' ? 'en' : 'zh', lastSeq: num(row.last_seq) };
  });

  // GET /internal/v1/sessions/:id/events?afterSeq&limit<=500 -> full internal envelopes
  app.get(`${P}/:id/events`, { schema: { params: SessionParams, querystring: GetEventsQuery } }, async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { afterSeq?: string; limit?: string };
    const afterSeq = query.afterSeq === undefined ? 0 : Number(query.afterSeq);
    const limit = query.limit === undefined ? MAX_EVENTS_PAGE : Number(query.limit);
    if (!Number.isSafeInteger(afterSeq) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS_PAGE) {
      throw new HttpError('VALIDATION_FAILED', `limit must be 1..${MAX_EVENTS_PAGE}`);
    }
    const [s] = await q(ctx.pool, 'SELECT 1 FROM app.sessions WHERE id = $1', [id]);
    if (!s) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    const rows = await q(
      ctx.pool,
      `SELECT ${EVENT_COLUMNS} FROM app.events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [id, afterSeq, limit + 1],
    );
    const events = rows.slice(0, limit).map((r) => {
      const e = eventRowFromDb(r);
      return {
        id: e.id,
        sessionId: e.sessionId,
        seq: e.seq,
        type: e.type,
        actor: e.actor,
        ts: e.ts,
        traceId: e.traceId,
        idempotencyKey: e.idempotencyKey,
        schemaVersion: 1 as const,
        payload: e.payload,
      };
    });
    return { events, hasMore: rows.length > limit };
  });

  // POST /internal/v1/sessions/:id/events: the 7-step emit (A-01 §5.1)
  app.post(`${P}/:id/events`, { schema: { params: SessionParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fence = fenceOf(req);
    // step 1a: size (raw bytes) and envelope shape
    if ((RAW_BYTES.get(req) ?? 0) > MAX_EMIT_BODY_BYTES) throw invalid(`body exceeds ${MAX_EMIT_BODY_BYTES} bytes`);
    const body = req.body as Record<string, unknown> | undefined;
    if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof body.type !== 'string') {
      throw invalid('body must be { type, payload, idempotencyKey }');
    }
    // step 3: type whitelist (CT-11): only harness-writable DURABLE types; booking.*, user.* -> 403
    const type = body.type;
    if (!canWrite('harness', type) || !Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, type)) {
      throw new HttpError('EVENT_TYPE_FORBIDDEN', `harness may not write ${type}`);
    }
    // step 1b: payload schema (M-16 discriminated agent.message etc.), strict, no extra keys
    if (!check(EmitEventRequest, body)) throw invalid(`payload does not match the ${type} schema`);
    const payload = body.payload as Record<string, unknown>;
    const idempotencyKey = body.idempotencyKey as string;

    const res = await withUniqueRetry(() =>
      tx(ctx.pool, async (c) => {
        // step 2: lock the session row
        const s = await lockSession(c, id);
        if (!s) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
        if (type === 'agent.run_started') await checkRunStarted(c, id, s.lastUserSeq, payload);
        // step 4: fence (every harness write, no exceptions)
        await fenceOk(ctx, id, fence, s.maxFenceSeen);
        // step 5: quote.offered must match an offer row of THIS session
        if (type === 'quote.offered') {
          const r = await c.query(
            'SELECT 1 FROM app.quote_offers WHERE quote_id = $1 AND tool_call_id = $2 AND session_id = $3',
            [payload.quoteId, payload.toolCallId, id],
          );
          if (r.rowCount === 0) throw invalid('quote.offered has no matching quote_offers row in this session');
        }
        // steps 6 + 7: idempotency, insert, tracking
        return appendEvent(c, s, {
          type: type as EventType,
          payload,
          idempotencyKey,
          traceId: req.trace.traceId,
          source: 'harness',
          fence,
        });
      }),
    );
    if (res.kind === 'conflict')
      throw new HttpError('IDEMPOTENCY_CONFLICT', 'idempotencyKey reused with other content');
    if (res.kind === 'duplicate')
      return reply.code(200).send({ seq: res.event.seq, id: res.event.id, deduplicated: true });
    // step 8: after commit
    await ctx.notifier.evt(id, res.event.seq);
    if (res.statusChanged) await ctx.notifier.status(id, res.status);
    return reply.code(201).send({ seq: res.event.seq, id: res.event.id });
  });

  // POST /internal/v1/sessions/:id/hands-token (A-01 §5.3)
  app.post(`${P}/:id/hands-token`, { schema: { params: SessionParams } }, async (req) => {
    const { id } = req.params as { id: string };
    const fence = fenceOf(req);
    const [row] = await q(
      ctx.pool,
      'SELECT user_id, last_user_seq, consumed_up_to_seq, open_run_id, max_fence_seen FROM app.sessions WHERE id = $1',
      [id],
    );
    if (!row) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    await fenceOk(ctx, id, fence, num(row.max_fence_seen));
    const active = num(row.last_user_seq) > num(row.consumed_up_to_seq) || row.open_run_id !== null;
    if (!active) throw new HttpError('SESSION_INACTIVE', 'no unconsumed input and no open run');
    return ctx.handsToken.sign({ sid: id, uid: String(row.user_id) });
  });
}
