// booking HTTP API (A-01 §5.4): POST /internal/v1/bookings, GET /healthz, GET /readyz. gateway is the only client.
// Order of checks for every request:
//   1. peer address ∈ allowedPeers (platform onRequest hook, socket.remoteAddress)  → 403 FORBIDDEN_PEER
//   2. Authorization: Bearer <booking_service_token> (route onRequest, before the body is even parsed) → 401
//   3. body schema CreateBookingRequest, ajv without coercion / stripping (platform, CT-07)          → 400
//   4. the booking transaction (booking.ts)
import { createHash, timingSafeEqual } from 'node:crypto';
import { CreateBookingRequest } from '@fb/contracts/server';
import { buildServer, HttpError, type FastifyInstance, type FastifyRequest } from '@fb/platform/fastify';
import type { Logger } from '@fb/platform/log';
import type { Pool } from '@fb/platform/pg';
import { confirmBooking, isUnavailable, type ConfirmBookingOptions } from './booking.ts';

export const BOOKINGS_PATH = '/internal/v1/bookings';

export interface BookingAppOptions extends ConfirmBookingOptions {
  readonly pool: Pool;
  /** booking_service_token, read through SecretProvider by the caller (never from the environment) */
  readonly serviceToken: string;
  /** gateway only: 172.30.3.20/32 in compose (A-01 §2.2) */
  readonly allowedPeers: readonly string[];
  readonly logger?: Logger;
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time Bearer check; hashing first makes the comparison independent of the presented length. */
export function makeTokenCheck(serviceToken: string): (authorization: unknown) => boolean {
  if (serviceToken.length === 0) throw new Error('booking_service_token is empty');
  const expected = digest(serviceToken);
  return (authorization) => {
    if (typeof authorization !== 'string') return false;
    const m = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
    if (m === null || m[1] === undefined) return false;
    return timingSafeEqual(digest(m[1]), expected);
  };
}

export async function buildBookingApp(options: BookingAppOptions): Promise<FastifyInstance> {
  const tokenOk = makeTokenCheck(options.serviceToken);
  const { pool } = options;
  const confirmOptions: ConfirmBookingOptions =
    options.newTicketId !== undefined ? { newTicketId: options.newTicketId } : {};

  const requireServiceToken = async (req: FastifyRequest): Promise<void> => {
    if (!tokenOk(req.headers.authorization)) {
      req.log.warn({ peer: req.raw.socket.remoteAddress }, 'booking: service token missing or invalid');
      throw new HttpError('SERVICE_AUTH_INVALID', 'service token missing or invalid');
    }
  };

  return buildServer({
    allowedPeers: options.allowedPeers,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ready: async () => {
      await pool.query('SELECT 1');
    },
    routes: (app) => {
      app.post(
        BOOKINGS_PATH,
        { onRequest: requireServiceToken, schema: { body: CreateBookingRequest } },
        async (req, reply) => {
          const body = req.body as CreateBookingRequest;
          const log = req.log.child({ quoteId: body.quoteId, requestId: body.requestId, traceId: req.trace.traceId });
          let result;
          try {
            result = await confirmBooking(pool, { quoteId: body.quoteId, userId: body.userId }, confirmOptions);
          } catch (err) {
            if (isUnavailable(err)) {
              log.warn({ err }, 'booking: database unavailable');
              throw new HttpError('SERVICE_UNAVAILABLE', 'booking database unavailable');
            }
            log.error({ err }, 'booking: unexpected failure');
            throw new HttpError('INTERNAL', 'internal error');
          }
          switch (result.kind) {
            case 'created':
              log.info({ ticketId: result.ticket.ticketId }, 'booking: ticket issued');
              return reply.code(201).send({ ticket: result.ticket });
            case 'already_booked':
              log.info({ ticketId: result.ticket.ticketId }, 'booking: quote already booked, returning first ticket');
              return reply.code(200).send({ ticket: result.ticket, alreadyBooked: true });
            case 'not_found':
              log.info('booking: quote not found for user');
              throw new HttpError('QUOTE_NOT_FOUND', 'quote not found');
            case 'not_offered':
              log.info('booking: quote was never offered');
              throw new HttpError('QUOTE_NOT_OFFERED', 'quote was never offered in its session');
          }
        },
      );
    },
  });
}
