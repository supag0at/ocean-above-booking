// T07 core: the booking transaction (A-01 §5.2 steps a–d, §3.3, O-1, S-13; CONTRACT-v1 M-21).
//
// One transaction, READ COMMITTED:
//   a. the quote exists AND belongs to the caller's user          → otherwise not_found  (404 QUOTE_NOT_FOUND)
//   b. the quote was offered in its own session (quote_offers)     → otherwise not_offered (409 QUOTE_NOT_OFFERED)
//   c. INSERT the ticket ON CONFLICT (quote_id) DO NOTHING
//        row returned  → created (201)
//        no row        → the quote was already used: return the FIRST ticket (200 alreadyBooked)
//        unique violation on id / ticket_no (random collision) → roll back to a savepoint, new id, ≤ 3 attempts
//   d. COMMIT
//
// Why this is race-free: the only "has this quote been used?" decision is the INSERT itself, arbitrated by the
// UNIQUE index on tickets.quote_id. There is no read-then-write window. Under READ COMMITTED a concurrent INSERT
// of the same quote_id blocks on the other transaction's uncommitted index entry; when that one commits, ours
// does nothing and returns no row; the follow-up SELECT is a new statement with a new snapshot, so it sees the
// committed winner. If the winner rolls back instead, ours inserts. Steps a/b read rows that are immutable
// (quotes / quote_offers have UPDATE/DELETE triggers and no runtime grants for it), so they cannot change
// underneath us either. Quotes never expire (D-10).
//
// booking never writes events: booking.confirmed / booking.failed are gateway's (M-21; fb_booking has no grant).
import { newTicketId as defaultNewTicketId, ticketNoFromId } from '@fb/contracts/server';
import type { Quote, TicketView } from '@fb/contracts/web';
import type { Pool } from '@fb/platform/pg';

// pool.connect() is overloaded (callback form returns void); infer the client type from the promise form
const connectClient = (pool: Pool) => pool.connect();
type PoolClient = Awaited<ReturnType<typeof connectClient>>;

export interface ConfirmBookingInput {
  readonly quoteId: string;
  readonly userId: string;
}

export type ConfirmBookingResult =
  | { readonly kind: 'created'; readonly ticket: TicketView }
  | { readonly kind: 'already_booked'; readonly ticket: TicketView }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_offered' };

export interface ConfirmBookingOptions {
  /** ticket id generator; injectable only so tests can force an id collision (S-13) */
  readonly newTicketId?: () => string;
}

/** S-13: retries for a random id / ticket_no collision inside the same transaction. */
export const MAX_ID_ATTEMPTS = 3;

/** Thrown for states that cannot happen with a consistent database (mapped to 500 INTERNAL). */
export class BookingInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingInvariantError';
  }
}

interface QuoteRow {
  id: string;
  user_id: string;
  session_id: string;
  from_city: string;
  to_city: string;
  payload: unknown;
}

interface TicketRow {
  id: string;
  ticket_no: string;
  session_id: string;
  quote_id: string;
  from_city: string;
  to_city: string;
  itinerary: Quote;
  price_cents: number;
  booked_at: Date;
}

const TICKET_COLUMNS = 'id, ticket_no, session_id, quote_id, from_city, to_city, itinerary, price_cents, booked_at';

/** Unique constraints whose violation means "random id collided", i.e. retry with a fresh id. */
const ID_COLLISION_CONSTRAINTS = new Set(['tickets_pkey', 'tickets_ticket_no_key']);

function toTicketView(row: TicketRow): TicketView {
  return {
    ticketId: row.id,
    ticketNo: row.ticket_no,
    sessionId: row.session_id,
    quoteId: row.quote_id,
    from: row.from_city,
    to: row.to_city,
    itinerary: row.itinerary,
    priceCents: row.price_cents,
    bookedAt: row.booked_at.toISOString(),
  };
}

/** The ticket copies the quote's numbers; nothing is recomputed (A-01 §3.2, H-01). Refuse a corrupt snapshot. */
function quoteNumbers(quote: QuoteRow): { totalDistanceKm: number; priceCents: number } {
  const p = quote.payload as Partial<Quote> | null;
  if (p === null || typeof p !== 'object')
    throw new BookingInvariantError(`quote ${quote.id}: payload is not an object`);
  if (p.quoteId !== quote.id) throw new BookingInvariantError(`quote ${quote.id}: payload.quoteId mismatch`);
  const { totalDistanceKm, priceCents } = p;
  if (typeof totalDistanceKm !== 'number' || !Number.isFinite(totalDistanceKm) || totalDistanceKm < 0) {
    throw new BookingInvariantError(`quote ${quote.id}: payload.totalDistanceKm invalid`);
  }
  if (typeof priceCents !== 'number' || !Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new BookingInvariantError(`quote ${quote.id}: payload.priceCents invalid`);
  }
  return { totalDistanceKm, priceCents };
}

function isIdCollision(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && typeof e.constraint === 'string' && ID_COLLISION_CONSTRAINTS.has(e.constraint);
}

async function runInTransaction(client: PoolClient, input: ConfirmBookingInput, newId: () => string) {
  const quotes = await client.query<QuoteRow>(
    'SELECT id, user_id, session_id, from_city, to_city, payload FROM app.quotes WHERE id = $1 AND user_id = $2',
    [input.quoteId, input.userId],
  );
  const quote = quotes.rows[0];
  // a. someone else's quote and a non-existent quote are indistinguishable on purpose (A-01 §4.6)
  if (quote === undefined) return { kind: 'not_found' } as const;

  // b. offered in the quote's own session; quote_offers is the source of truth, not events (T07)
  const offers = await client.query('SELECT 1 FROM app.quote_offers WHERE quote_id = $1 AND session_id = $2 LIMIT 1', [
    quote.id,
    quote.session_id,
  ]);
  if (offers.rowCount === 0) return { kind: 'not_offered' } as const;

  const { totalDistanceKm, priceCents } = quoteNumbers(quote);

  // c. the INSERT is the one-ticket-per-quote decision
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
    const ticketId = newId();
    const ticketNo = ticketNoFromId(ticketId);
    await client.query('SAVEPOINT ticket_insert');
    let inserted;
    try {
      inserted = await client.query<TicketRow>(
        `INSERT INTO app.tickets
           (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary, total_distance_km, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (quote_id) DO NOTHING
         RETURNING ${TICKET_COLUMNS}`,
        [
          ticketId,
          ticketNo,
          quote.user_id,
          quote.session_id,
          quote.id,
          quote.from_city,
          quote.to_city,
          JSON.stringify(quote.payload),
          totalDistanceKm,
          priceCents,
        ],
      );
    } catch (err) {
      if (isIdCollision(err) && attempt < MAX_ID_ATTEMPTS) {
        await client.query('ROLLBACK TO SAVEPOINT ticket_insert');
        continue;
      }
      throw err;
    }
    await client.query('RELEASE SAVEPOINT ticket_insert');

    const created = inserted.rows[0];
    if (created !== undefined) return { kind: 'created', ticket: toTicketView(created) } as const;

    // already used: return the first ticket (idempotent), never a second one
    const existing = await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM app.tickets WHERE quote_id = $1`, [
      quote.id,
    ]);
    const first = existing.rows[0];
    if (first === undefined) throw new BookingInvariantError(`quote ${quote.id}: conflict but no ticket visible`);
    return { kind: 'already_booked', ticket: toTicketView(first) } as const;
  }
  // unreachable: the last attempt either returns or rethrows
  throw new BookingInvariantError('ticket id attempts exhausted');
}

/** A-01 §5.2 a–d in one READ COMMITTED transaction. Database errors propagate (the HTTP layer maps them). */
export async function confirmBooking(
  pool: Pool,
  input: ConfirmBookingInput,
  options: ConfirmBookingOptions = {},
): Promise<ConfirmBookingResult> {
  const newId = options.newTicketId ?? defaultNewTicketId;
  const client = await connectClient(pool);
  let broken: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    let result: ConfirmBookingResult;
    try {
      result = await runInTransaction(client, input, newId);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr as Error; // connection is unusable: destroy it instead of returning it to the pool
      }
      throw err;
    }
    // rejections wrote nothing; commit is harmless and ends the transaction either way
    await client.query('COMMIT');
    return result;
  } catch (err) {
    broken ??= isConnectionLevel(err) ? (err as Error) : undefined;
    throw err;
  } finally {
    client.release(broken);
  }
}

// ---- error classification (A-01 §5.4: dependency failures are 503 SERVICE_UNAVAILABLE, retry is safe) ----

const NODE_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

function isConnectionLevel(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return NODE_NET_CODES.has(code) || code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03';
}

/**
 * true when a retry is safe and the failure is the dependency's, not ours: connection problems, server shutdown,
 * resource exhaustion, statement / connect timeouts, serialization failures and deadlocks. Everything else is
 * a bug or a data problem (500 INTERNAL).
 */
export function isUnavailable(err: unknown): boolean {
  if (err instanceof BookingInvariantError) return false;
  if (isConnectionLevel(err)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (code.startsWith('53') || code === '57014' || code === '40001' || code === '40P01')) {
    return true;
  }
  const message = err instanceof Error ? err.message : '';
  // pg-pool / pg client timeouts carry no code
  return /timeout|Connection terminated|connection.*(ended|closed)/i.test(message);
}
