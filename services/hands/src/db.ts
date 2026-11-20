// Data access for hands (A-01 §3.3: SELECT on sessions(id,user_id,last_user_seq), quotes, quote_offers,
// tool_calls, tickets, user_memories, memory_deletions; INSERT on quotes, quote_offers, tool_calls, user_memories).
// Every query is scoped by the identity taken from the hands token, never by tool arguments (H-04).
import type { Pool } from '@fb/platform/pg';
import type { ExecuteResponse } from '@fb/contracts/tools';
import type { Quote, TicketView } from '@fb/contracts/web';
import type { MemoryDeletionRow, MemoryKey, MemoryRow, TicketRow } from './ports.ts';

/** Anything that can run a query: the pool or a client inside a transaction. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors pg's own `R extends QueryResultRow = any`
  query<R extends Record<string, any> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
export interface Client extends Queryable {
  release(): void;
}

export interface SessionRow {
  userId: string;
  lastUserSeq: number;
}

export interface ToolCallRow {
  name: string;
  inputSha256: string;
  response: ExecuteResponse;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export async function getSession(q: Queryable, sessionId: string): Promise<SessionRow | undefined> {
  const r = await q.query<{ user_id: string; last_user_seq: string }>(
    'SELECT user_id, last_user_seq FROM app.sessions WHERE id = $1',
    [sessionId],
  );
  const row = r.rows[0];
  return row ? { userId: row.user_id, lastUserSeq: Number(row.last_user_seq) } : undefined;
}

export async function getToolCall(
  q: Queryable,
  sessionId: string,
  runId: string,
  toolCallId: string,
): Promise<ToolCallRow | undefined> {
  const r = await q.query<{ name: string; input_sha256: string; response: ExecuteResponse }>(
    'SELECT name, input_sha256, response FROM app.tool_calls WHERE session_id = $1 AND run_id = $2 AND tool_call_id = $3',
    [sessionId, runId, toolCallId],
  );
  const row = r.rows[0];
  return row ? { name: row.name, inputSha256: row.input_sha256, response: row.response } : undefined;
}

/** Last statement of the tool transaction (A-01 §5.5 step 2). A concurrent duplicate fails here with 23505. */
export async function insertToolCall(
  q: Queryable,
  k: { sessionId: string; runId: string; toolCallId: string; name: string; inputSha256: string },
  response: ExecuteResponse,
): Promise<void> {
  await q.query(
    'INSERT INTO app.tool_calls (session_id, run_id, tool_call_id, name, input_sha256, response) VALUES ($1, $2, $3, $4, $5, $6)',
    [k.sessionId, k.runId, k.toolCallId, k.name, k.inputSha256, JSON.stringify(response)],
  );
}

export async function insertQuote(q: Queryable, userId: string, sessionId: string, quote: Quote): Promise<void> {
  await q.query(
    `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [quote.quoteId, userId, sessionId, quote.from, quote.to, quote.dataSha256, JSON.stringify(quote), quote.createdAt],
  );
}

/** Quote visible to this session (offer_booking only offers quotes of the current session, A-02 §5.3). */
export async function quoteInSession(
  q: Queryable,
  quoteId: string,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const r = await q.query('SELECT 1 FROM app.quotes WHERE id = $1 AND session_id = $2 AND user_id = $3', [
    quoteId,
    sessionId,
    userId,
  ]);
  return r.rowCount === 1;
}

export async function ticketNoForQuote(q: Queryable, quoteId: string): Promise<string | undefined> {
  const r = await q.query<{ ticket_no: string }>('SELECT ticket_no FROM app.tickets WHERE quote_id = $1', [quoteId]);
  return r.rows[0]?.ticket_no;
}

/**
 * One row per offer. ON CONFLICT: the same (quote, toolCallId) in a different run (vendor ids are not
 * guaranteed unique across runs, S-15) is the same offer card; the row already exists, nothing to add.
 */
export async function insertQuoteOffer(
  q: Queryable,
  quoteId: string,
  sessionId: string,
  toolCallId: string,
): Promise<void> {
  await q.query(
    'INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [quoteId, sessionId, toolCallId],
  );
}

type TicketDbRow = {
  id: string;
  ticket_no: string;
  session_id: string;
  quote_id: string;
  from_city: string;
  to_city: string;
  itinerary: Quote;
  price_cents: number;
  booked_at: Date | string;
};

const CITY_FILTER = `EXISTS (SELECT 1 FROM jsonb_array_elements(t.itinerary->'legs') AS l
                             WHERE l->>'from' = $2 OR l->>'to' = $2)`;

export async function listTickets(
  q: Queryable,
  userId: string,
  opts: { city?: string; limit: number },
): Promise<{ tickets: TicketView[]; total: number }> {
  const where = opts.city === undefined ? 't.user_id = $1' : `t.user_id = $1 AND ${CITY_FILTER}`;
  const params: unknown[] = opts.city === undefined ? [userId] : [userId, opts.city];
  const count = await q.query<{ n: string }>(`SELECT count(*) AS n FROM app.tickets t WHERE ${where}`, params);
  const rows = await q.query<TicketDbRow>(
    `SELECT t.id, t.ticket_no, t.session_id, t.quote_id, t.from_city, t.to_city, t.itinerary, t.price_cents, t.booked_at
       FROM app.tickets t WHERE ${where}
      ORDER BY t.booked_at DESC, t.id DESC LIMIT $${params.length + 1}`,
    [...params, opts.limit],
  );
  return {
    total: Number(count.rows[0]?.n ?? 0),
    tickets: rows.rows.map((t) => ({
      ticketId: t.id,
      ticketNo: t.ticket_no,
      sessionId: t.session_id,
      quoteId: t.quote_id,
      from: t.from_city,
      to: t.to_city,
      itinerary: t.itinerary,
      priceCents: t.price_cents,
      bookedAt: iso(t.booked_at),
    })),
  };
}

/** Append-only write (D-32): save inserts a value, forget inserts a tombstone (value NULL). */
export async function insertMemory(
  q: Queryable,
  m: { userId: string; key: MemoryKey; value: string | null; sourceSessionId: string; sourceSeq: number },
): Promise<string> {
  const r = await q.query<{ id: string }>(
    `INSERT INTO app.user_memories (user_id, key, value, source_session_id, source_seq)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [m.userId, m.key, m.value, m.sourceSessionId, m.sourceSeq],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('user_memories insert returned no id');
  return id;
}

export async function listMemories(q: Queryable, userId: string): Promise<MemoryRow[]> {
  const r = await q.query<{
    id: string;
    user_id: string;
    key: MemoryKey;
    value: string | null;
    source_session_id: string;
    source_seq: string;
    created_at: Date | string;
  }>(
    `SELECT id, user_id, key, value, source_session_id, source_seq, created_at
       FROM app.user_memories WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return r.rows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    key: m.key,
    value: m.value,
    sourceSessionId: m.source_session_id,
    sourceSeq: Number(m.source_seq),
    createdAt: iso(m.created_at),
  }));
}

export async function listMemoryDeletions(q: Queryable, userId: string): Promise<MemoryDeletionRow[]> {
  const r = await q.query<{ memory_id: string; user_id: string }>(
    'SELECT memory_id, user_id FROM app.memory_deletions WHERE user_id = $1',
    [userId],
  );
  return r.rows.map((d) => ({ memoryId: d.memory_id, userId: d.user_id }));
}

export async function listTicketRows(q: Queryable, userId: string): Promise<TicketRow[]> {
  const r = await q.query<{ id: string; user_id: string; from_city: string; to_city: string; booked_at: Date }>(
    'SELECT id, user_id, from_city, to_city, booked_at FROM app.tickets WHERE user_id = $1',
    [userId],
  );
  return r.rows.map((t) => ({
    ticketId: t.id,
    userId: t.user_id,
    from: t.from_city,
    to: t.to_city,
    bookedAt: iso(t.booked_at),
  }));
}

/** Runs `fn` in one transaction (READ COMMITTED). Rolls back on any error. */
export async function inTransaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c: Client = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export function isToolCallKeyConflict(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === 'tool_calls_pkey';
}
