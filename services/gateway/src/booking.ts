// Confirm chain, gateway side (A-01 §5.2, §4.6 mapping table; D-39, D-51; CONTRACT M-21).
// booking.confirmed / booking.failed are written by the gateway as the system actor and NEVER ring the doorbell.
import { HttpError } from '@fb/platform/fastify';
import type { HttpClient } from '@fb/platform/http';
import type { Logger } from '@fb/platform/log';
import {
  CreateBookingResponse,
  bookingConfirmedIdempotencyKey,
  bookingFailedIdempotencyKey,
  idPattern,
  ID_PREFIX,
} from '@fb/contracts/server';
import type { TicketView } from '@fb/contracts/web';
import { appendEvent, lockSession, type AppendResult } from './append.ts';
import { tx, type Pool } from './db.ts';
import type { Notifier } from './doorbell.ts';
import { check } from './validate.ts';
import { pickTicket, ticketSummary } from './views.ts';

export const QUOTE_ID_RE = new RegExp(idPattern(ID_PREFIX.quote));

export interface SystemWriterDeps {
  readonly pool: Pool;
  readonly notifier: Notifier;
  readonly log: Logger;
}

/** Append one system event to a session (own transaction) and notify SSE. Never rings the doorbell. */
async function appendSystem(
  d: SystemWriterDeps,
  sessionId: string,
  type: 'booking.confirmed' | 'booking.failed',
  payload: Record<string, unknown>,
  idempotencyKey: string,
  traceId: string,
): Promise<AppendResult> {
  const res = await tx(d.pool, async (c) => {
    const s = await lockSession(c, sessionId);
    if (!s) throw new Error(`session ${sessionId} of a ticket/quote does not exist`);
    return appendEvent(c, s, { type, payload, idempotencyKey, traceId, source: 'system' });
  });
  if (res.kind === 'created') {
    await d.notifier.evt(sessionId, res.event.seq);
    if (res.statusChanged) await d.notifier.status(sessionId, res.status);
  } else if (res.kind === 'conflict') {
    d.log.error({ sessionId, type, idempotencyKey }, 'system event idempotency conflict');
  }
  return res;
}

/** idempotencyKey booking:{quoteId}: user retry and sweeper reconciliation write it at most once (A-01 §5.2). */
export function writeBookingConfirmed(d: SystemWriterDeps, ticket: TicketView, traceId: string): Promise<AppendResult> {
  return appendSystem(
    d,
    ticket.sessionId,
    'booking.confirmed',
    { quoteId: ticket.quoteId, ticketId: ticket.ticketId, ticketNo: ticket.ticketNo, summary: ticketSummary(ticket) },
    bookingConfirmedIdempotencyKey(ticket.quoteId),
    traceId,
  );
}

export interface ConfirmDeps extends SystemWriterDeps {
  readonly booking: HttpClient;
}

export type ConfirmOutcome = { status: 201; ticket: TicketView } | { status: 200; ticket: TicketView };

interface ErrorBody {
  error?: { code?: unknown };
}

export async function confirmQuote(
  d: ConfirmDeps,
  args: { quoteId: string; userId: string; traceId: string; traceparent: string },
): Promise<ConfirmOutcome> {
  if (!QUOTE_ID_RE.test(args.quoteId)) throw new HttpError('QUOTE_NOT_FOUND', 'quote not found');

  let res;
  try {
    res = await d.booking.post(
      '/internal/v1/bookings',
      { quoteId: args.quoteId, userId: args.userId, requestId: args.traceId },
      { traceparent: args.traceparent, timeoutMs: 5000, retries: 0 },
    );
  } catch (err) {
    d.log.warn({ quoteId: args.quoteId, err: (err as Error).name }, 'booking unreachable');
    throw new HttpError('BOOKING_UNAVAILABLE', 'booking unavailable');
  }

  let body: unknown;
  try {
    body = res.json();
  } catch {
    body = undefined;
  }

  if (res.status === 201 || res.status === 200) {
    if (!check(CreateBookingResponse, body)) {
      d.log.error({ status: res.status }, 'booking returned a malformed ticket');
      throw new HttpError('INTERNAL', 'booking contract violation');
    }
    const ticket = pickTicket((body as { ticket: TicketView }).ticket);
    const replay = (body as { alreadyBooked?: unknown }).alreadyBooked === true;
    if (ticket.quoteId !== args.quoteId || (res.status === 200) !== replay) {
      d.log.error({ status: res.status }, 'booking response does not match the request');
      throw new HttpError('INTERNAL', 'booking contract violation');
    }
    // the ticket is issued: an event-write failure must not turn it into an error (the sweeper reconciles, I-9)
    try {
      await writeBookingConfirmed(d, ticket, args.traceId);
    } catch (err) {
      d.log.error({ quoteId: args.quoteId, err: (err as Error).message }, 'booking.confirmed write failed');
    }
    return res.status === 201 ? { status: 201, ticket } : { status: 200, ticket };
  }

  const code = (body as ErrorBody | undefined)?.error?.code;
  if (res.status === 404 && code === 'QUOTE_NOT_FOUND') {
    // nothing is written: never leave a trace in someone else's session
    throw new HttpError('QUOTE_NOT_FOUND', 'quote not found');
  }
  if (res.status === 409 && code === 'QUOTE_NOT_OFFERED') {
    await writeBookingFailedForQuote(d, args.quoteId, args.userId, args.traceId);
    throw new HttpError('QUOTE_NOT_OFFERED', 'quote was never offered in its session');
  }
  if (res.status >= 500) throw new HttpError('BOOKING_UNAVAILABLE', 'booking unavailable');
  // 400 / 401 / anything else: gateway <-> booking contract is broken
  d.log.error({ status: res.status, code: typeof code === 'string' ? code : undefined }, 'unexpected booking response');
  throw new HttpError('INTERNAL', 'booking contract violation');
}

/** booking.failed goes to the quote's own session, and only if the quote belongs to the caller. */
async function writeBookingFailedForQuote(
  d: ConfirmDeps,
  quoteId: string,
  userId: string,
  traceId: string,
): Promise<void> {
  try {
    const r = await d.pool.query('SELECT session_id FROM app.quotes WHERE id = $1 AND user_id = $2', [quoteId, userId]);
    const sessionId = (r.rows[0] as { session_id?: string } | undefined)?.session_id;
    if (!sessionId) return;
    await appendSystem(
      d,
      sessionId,
      'booking.failed',
      { quoteId, code: 'QUOTE_NOT_OFFERED' },
      bookingFailedIdempotencyKey(quoteId, traceId),
      traceId,
    );
  } catch (err) {
    d.log.error({ quoteId, err: (err as Error).message }, 'booking.failed write failed');
  }
}
