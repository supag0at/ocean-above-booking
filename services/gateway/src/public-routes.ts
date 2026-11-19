// Public API on :8080 (A-01 §4.1–§4.4). Identity only from the fb_sid cookie (H-04); other users' resources are
// always 404 (never 403); request bodies are schema-checked by the platform's strict ajv (D-24, H-08).
import { escapeUserText, userMessageIdempotencyKey } from '@fb/contracts/server';
import {
  API_PREFIX,
  CreateSessionBodySchema,
  EventsQuerySchema,
  LoginBodySchema,
  MemoryIdParamsSchema,
  PageQuerySchema,
  PatchMeBodySchema,
  PostMessageBodySchema,
  QuoteIdParamsSchema,
  SessionIdParamsSchema,
  StreamQuerySchema,
  TicketIdParamsSchema,
  type CreateSessionBody,
  type LoginBody,
  type MemoryView,
  type PatchMeBody,
  type PostMessageBody,
  type SessionStatus,
  type UserView,
} from '@fb/contracts/web';
import { HttpError, type FastifyInstance, type FastifyRequest } from '@fb/platform/fastify';
import { appendEvent, lockSession, type AppendResult } from './append.ts';
import {
  authOfRequest,
  clearAuthCookies,
  readGuard,
  redisOr503,
  setAuthCookies,
  sidFrom,
  writeGuard,
  type AuthContext,
} from './auth.ts';
import { confirmQuote } from './booking.ts';
import type { GatewayContext } from './context.ts';
import { UUID_RE, iso, num, q, tx, withUniqueRetry } from './db.ts';
import {
  EVENT_COLUMNS,
  SESSION_COLUMNS,
  TICKET_COLUMNS,
  eventRowFromDb,
  quoteView,
  sessionView,
  ticketView,
  toPublicEvent,
} from './views.ts';

const P = API_PREFIX;
const SESSIONS_PAGE = { def: 20, max: 50 };
const EVENTS_PAGE = { def: 100, max: 200 };
const USERNAME_MAX = 32;

/** A-01 §4.3 / S-5 / M-19: NFKC + trim + lower, then 1..32 code points. */
export function normalizeUsername(raw: string): string | null {
  const norm = raw.normalize('NFKC').trim().toLowerCase();
  const len = [...norm].length;
  return len >= 1 && len <= USERNAME_MAX ? norm : null;
}

function limitOf(raw: string | undefined, page: { def: number; max: number }): number {
  if (raw === undefined) return page.def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > page.max) {
    throw new HttpError('VALIDATION_FAILED', `limit must be 1..${page.max}`);
  }
  return n;
}

function seqOf(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!/^[0-9]{1,15}$/.test(raw) || !Number.isSafeInteger(n)) throw new HttpError('VALIDATION_FAILED', 'bad seq');
  return n;
}

// cursor = base64url(JSON { k: sort key (timestamptz text, µs precision), i: id }) (A-01 §4.1, S-3)
interface Cursor {
  k: string;
  i: string;
}
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string | undefined, idRe: RegExp): Cursor | null {
  if (raw === undefined) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof c.k === 'string' &&
      typeof c.i === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.k) &&
      idRe.test(c.i)
    ) {
      return { k: c.k, i: c.i };
    }
  } catch {
    /* fall through */
  }
  throw new HttpError('VALIDATION_FAILED', 'bad cursor');
}
const SORT_KEY = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const authOf = (req: FastifyRequest): AuthContext => {
  const a = authOfRequest(req);
  if (!a) throw new HttpError('AUTH_REQUIRED', 'login required');
  return a;
};

function userView(r: Record<string, unknown>): UserView {
  return { id: String(r.id), username: String(r.username), locale: r.locale === 'en' ? 'en' : 'zh' };
}

export function registerPublicRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const read = readGuard(ctx.auth);
  const json = writeGuard('json', ctx.publicOrigin, ctx.auth);
  const bodyless = writeGuard('bodyless', ctx.publicOrigin, ctx.auth);
  const login = writeGuard('login', ctx.publicOrigin, ctx.auth);
  const cookieOpts = { secure: ctx.cookieSecure };

  const ownSession = async (sessionId: string, userId: string): Promise<Record<string, unknown>> => {
    if (!UUID_RE.test(sessionId)) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    const [row] = await q(ctx.pool, `SELECT ${SESSION_COLUMNS} FROM app.sessions WHERE id = $1 AND user_id = $2`, [
      sessionId,
      userId,
    ]);
    if (!row) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    return row;
  };

  app.get(`${P}/healthz`, async () => ({ ok: true }));

  // ---------------- auth / me ----------------
  app.post(`${P}/auth/login`, { onRequest: login, schema: { body: LoginBodySchema } }, async (req, reply) => {
    const { username } = req.body as LoginBody;
    const norm = normalizeUsername(username);
    if (norm === null)
      throw new HttpError('VALIDATION_FAILED', 'username must be 1..32 characters after normalisation');
    // rotate: an old login on this browser is destroyed first (A-01 §4.2)
    const old = await redisOr503(() => ctx.auth.resolve(sidFrom(req)));
    if (old) {
      await redisOr503(() => ctx.auth.destroy(old.key));
      await ctx.sse.logout(old.key);
    }
    let [row] = await q(
      ctx.pool,
      `INSERT INTO app.users (username, username_norm) VALUES ($1, $2)
       ON CONFLICT (username_norm) DO NOTHING RETURNING id, username, locale`,
      [username, norm],
    );
    if (!row) [row] = await q(ctx.pool, 'SELECT id, username, locale FROM app.users WHERE username_norm = $1', [norm]);
    if (!row) throw new HttpError('INTERNAL', 'user upsert failed');
    const user = userView(row);
    const s = await redisOr503(() => ctx.auth.create(user.id));
    setAuthCookies(reply, s.sid, s.csrf, cookieOpts);
    return { user };
  });

  app.post(`${P}/auth/logout`, { onRequest: bodyless }, async (req, reply) => {
    const auth = authOf(req);
    await redisOr503(() => ctx.auth.destroy(auth.key));
    await ctx.sse.logout(auth.key);
    clearAuthCookies(reply, cookieOpts);
    return reply.code(204).send();
  });

  app.get(`${P}/me`, { onRequest: read }, async (req) => {
    const [row] = await q(ctx.pool, 'SELECT id, username, locale FROM app.users WHERE id = $1', [authOf(req).userId]);
    if (!row) throw new HttpError('AUTH_REQUIRED', 'login required');
    return { user: userView(row) };
  });

  app.patch(`${P}/me`, { onRequest: json, schema: { body: PatchMeBodySchema } }, async (req) => {
    const { locale } = req.body as PatchMeBody;
    const [row] = await q(ctx.pool, 'UPDATE app.users SET locale = $2 WHERE id = $1 RETURNING id, username, locale', [
      authOf(req).userId,
      locale,
    ]);
    if (!row) throw new HttpError('AUTH_REQUIRED', 'login required');
    return { user: userView(row) };
  });

  // ---------------- sessions ----------------
  app.get(`${P}/sessions`, { onRequest: read, schema: { querystring: PageQuerySchema } }, async (req) => {
    const query = req.query as { cursor?: string; limit?: string };
    const limit = limitOf(query.limit, SESSIONS_PAGE);
    const cursor = decodeCursor(query.cursor, UUID_RE);
    const vals: unknown[] = [authOf(req).userId, limit + 1];
    let where = 'user_id = $1';
    if (cursor) {
      vals.push(cursor.k, cursor.i);
      where += ' AND (updated_at, id) < ($3::timestamptz, $4::uuid)';
    }
    const rows = await q(
      ctx.pool,
      `SELECT ${SESSION_COLUMNS}, ${SORT_KEY('updated_at')} AS sort_k FROM app.sessions
        WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $2`,
      vals,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(sessionView),
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({ k: String(last.sort_k), i: String(last.id) }) }
        : {}),
    };
  });

  app.post(`${P}/sessions`, { onRequest: json, schema: { body: CreateSessionBodySchema } }, async (req, reply) => {
    const body = req.body as CreateSessionBody;
    const userId = authOf(req).userId;
    // O-8: no session.created event; the first event of a session is its first user.message (seq 1)
    const [row] = await q(
      ctx.pool,
      `INSERT INTO app.sessions (user_id, locale)
         SELECT id, COALESCE($2, locale) FROM app.users WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
      [userId, body.locale ?? null],
    );
    if (!row) throw new HttpError('AUTH_REQUIRED', 'login required');
    return reply.code(201).send({ session: sessionView(row) });
  });

  app.get(`${P}/sessions/:id`, { onRequest: read, schema: { params: SessionIdParamsSchema } }, async (req) => {
    const { id } = req.params as { id: string };
    return { session: sessionView(await ownSession(id, authOf(req).userId)) };
  });

  app.get(
    `${P}/sessions/:id/events`,
    { onRequest: read, schema: { params: SessionIdParamsSchema, querystring: EventsQuerySchema } },
    async (req) => {
      const { id } = req.params as { id: string };
      const query = req.query as { afterSeq?: string; limit?: string };
      const afterSeq = seqOf(query.afterSeq);
      const limit = limitOf(query.limit, EVENTS_PAGE);
      await ownSession(id, authOf(req).userId);
      const rows = await q(
        ctx.pool,
        `SELECT ${EVENT_COLUMNS} FROM app.events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [id, afterSeq, limit + 1],
      );
      return {
        events: rows.slice(0, limit).map((r) => toPublicEvent(eventRowFromDb(r))),
        hasMore: rows.length > limit,
      };
    },
  );

  app.get(
    `${P}/sessions/:id/stream`,
    { onRequest: read, schema: { params: SessionIdParamsSchema, querystring: StreamQuerySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const auth = authOf(req);
      const header = req.headers['last-event-id'];
      const lastEventId = Array.isArray(header) ? header[0] : header;
      // Last-Event-ID (browser reconnect) wins over ?afterSeq (first connect)
      const afterSeq = seqOf(
        lastEventId !== undefined && lastEventId !== '' ? lastEventId : (req.query as { afterSeq?: string }).afterSeq,
      );
      const row = await ownSession(id, auth.userId);
      reply.hijack();
      await ctx.sse.open({
        res: reply.raw,
        sessionId: id,
        authKey: auth.key,
        afterSeq,
        traceId: req.trace.traceId,
        status: row.status as SessionStatus,
      });
    },
  );

  app.post(
    `${P}/sessions/:id/messages`,
    { onRequest: json, schema: { params: SessionIdParamsSchema, body: PostMessageBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as PostMessageBody;
      const userId = authOf(req).userId;
      if (!UUID_RE.test(id)) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
      // A-01 §4.3: one transaction: escape, idempotency on user:{clientMessageId}, append + tracking
      const payload = { text: escapeUserText(body.text), clientMessageId: body.clientMessageId };
      const res: AppendResult = await withUniqueRetry(() =>
        tx(ctx.pool, async (c) => {
          const s = await lockSession(c, id);
          if (!s || s.userId !== userId) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
          return appendEvent(c, s, {
            type: 'user.message',
            payload,
            idempotencyKey: userMessageIdempotencyKey(body.clientMessageId),
            traceId: req.trace.traceId,
            source: 'public',
          });
        }),
      );
      if (res.kind === 'conflict') {
        throw new HttpError('IDEMPOTENCY_CONFLICT', 'clientMessageId already used with a different text');
      }
      if (res.kind === 'duplicate') return reply.code(200).send({ event: toPublicEvent(res.event) });
      await ctx.notifier.evt(id, res.event.seq);
      if (res.statusChanged) await ctx.notifier.status(id, res.status);
      // after commit; a lost doorbell is recovered by the sweeper (A-01 §7.4)
      await ctx.doorbell.ringForMessage(id, res.event.seq, req.trace.traceparent);
      return reply.code(202).send({ event: toPublicEvent(res.event) });
    },
  );

  // ---------------- quotes / confirm ----------------
  app.get(`${P}/quotes/:quoteId`, { onRequest: read, schema: { params: QuoteIdParamsSchema } }, async (req) => {
    const { quoteId } = req.params as { quoteId: string };
    const [row] = await q(
      ctx.pool,
      `SELECT q.session_id, q.payload, t.id AS ticket_id, t.ticket_no
         FROM app.quotes q LEFT JOIN app.tickets t ON t.quote_id = q.id
        WHERE q.id = $1 AND q.user_id = $2`,
      [quoteId, authOf(req).userId],
    );
    if (!row) throw new HttpError('QUOTE_NOT_FOUND', 'quote not found');
    return {
      quote: {
        sessionId: String(row.session_id),
        quote: quoteView(row.payload),
        booking:
          row.ticket_id === null
            ? { status: 'available' as const }
            : { status: 'booked' as const, ticketId: String(row.ticket_id), ticketNo: String(row.ticket_no) },
      },
    };
  });

  // the ONLY booking entry point (H-02): cookie + CSRF + Origin, no body (O-3)
  app.post(
    `${P}/quotes/:quoteId/confirm`,
    { onRequest: bodyless, schema: { params: QuoteIdParamsSchema } },
    async (req, reply) => {
      const { quoteId } = req.params as { quoteId: string };
      const out = await confirmQuote(ctx, {
        quoteId,
        userId: authOf(req).userId,
        traceId: req.trace.traceId,
        traceparent: req.trace.traceparent,
      });
      return out.status === 201
        ? reply.code(201).send({ ticket: out.ticket })
        : reply.code(200).send({ ticket: out.ticket, alreadyBooked: true });
    },
  );

  // ---------------- tickets ----------------
  const TICKET_ID_RE = /^t_[0-9A-HJKMNP-TV-Z]{26}$/;
  app.get(`${P}/tickets`, { onRequest: read, schema: { querystring: PageQuerySchema } }, async (req) => {
    const query = req.query as { cursor?: string; limit?: string };
    const limit = limitOf(query.limit, SESSIONS_PAGE);
    const cursor = decodeCursor(query.cursor, TICKET_ID_RE);
    const vals: unknown[] = [authOf(req).userId, limit + 1];
    let where = 'user_id = $1';
    if (cursor) {
      vals.push(cursor.k, cursor.i);
      where += ' AND (booked_at, id) < ($3::timestamptz, $4::text)';
    }
    const rows = await q(
      ctx.pool,
      `SELECT ${TICKET_COLUMNS}, ${SORT_KEY('booked_at')} AS sort_k FROM app.tickets
        WHERE ${where} ORDER BY booked_at DESC, id DESC LIMIT $2`,
      vals,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(ticketView),
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({ k: String(last.sort_k), i: String(last.id) }) }
        : {}),
    };
  });

  app.get(`${P}/tickets/:ticketId`, { onRequest: read, schema: { params: TicketIdParamsSchema } }, async (req) => {
    const { ticketId } = req.params as { ticketId: string };
    const [row] = await q(ctx.pool, `SELECT ${TICKET_COLUMNS} FROM app.tickets WHERE id = $1 AND user_id = $2`, [
      ticketId,
      authOf(req).userId,
    ]);
    if (!row) throw new HttpError('TICKET_NOT_FOUND', 'ticket not found');
    return { ticket: ticketView(row) };
  });

  // ---------------- profile ----------------
  // effective value per (user, key): newest row only; tombstone (value NULL) or deleted -> absent, no fallback
  const effectiveMemories = async (userId: string): Promise<Record<string, unknown>[]> => {
    const rows = await q(
      ctx.pool,
      `SELECT DISTINCT ON (m.key) m.id, m.key, m.value, m.created_at, m.source_session_id, m.source_seq,
              (d.memory_id IS NOT NULL) AS deleted
         FROM app.user_memories m LEFT JOIN app.memory_deletions d ON d.memory_id = m.id
        WHERE m.user_id = $1
        ORDER BY m.key, m.created_at DESC, m.id DESC`,
      [userId],
    );
    return rows.filter((r) => r.value !== null && r.deleted !== true);
  };

  app.get(`${P}/profile`, { onRequest: read }, async (req) => {
    const rows = await effectiveMemories(authOf(req).userId);
    const preferences: MemoryView[] = rows.map((r) => ({
      memoryId: String(r.id),
      key: r.key === 'preferred_language' ? 'preferred_language' : 'home_city',
      value: String(r.value),
      createdAt: iso(r.created_at),
      source: { sessionId: String(r.source_session_id), seq: num(r.source_seq) },
    }));
    return { preferences };
  });

  app.delete(
    `${P}/profile/memories/:memoryId`,
    { onRequest: bodyless, schema: { params: MemoryIdParamsSchema } },
    async (req, reply) => {
      const { memoryId } = req.params as { memoryId: string };
      const userId = authOf(req).userId;
      if (!UUID_RE.test(memoryId)) throw new HttpError('MEMORY_NOT_FOUND', 'memory not found');
      const [row] = await q(ctx.pool, 'SELECT id FROM app.user_memories WHERE id = $1 AND user_id = $2', [
        memoryId,
        userId,
      ]);
      if (!row) throw new HttpError('MEMORY_NOT_FOUND', 'memory not found');
      // repeated deletes are 204 too
      await q(
        ctx.pool,
        'INSERT INTO app.memory_deletions (memory_id, user_id) VALUES ($1, $2) ON CONFLICT (memory_id) DO NOTHING',
        [memoryId, userId],
      );
      return reply.code(204).send();
    },
  );

  app.delete(`${P}/profile/memories`, { onRequest: bodyless }, async (req, reply) => {
    const userId = authOf(req).userId;
    const ids = (await effectiveMemories(userId)).map((r) => String(r.id));
    if (ids.length > 0) {
      await q(
        ctx.pool,
        `INSERT INTO app.memory_deletions (memory_id, user_id) SELECT unnest($1::uuid[]), $2
         ON CONFLICT (memory_id) DO NOTHING`,
        [ids, userId],
      );
    }
    return reply.code(204).send();
  });
}
