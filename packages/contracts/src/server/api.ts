// Internal HTTP API schemas: session API (A-01 §5.1), hands token (§5.3), booking API (§5.4), hands execute (§5.5,
// A-02 §5.1) and the shared error envelope (A-01 §4.1). Backend only. Requests never carry a user id except
// the booking request, which is gateway -> booking only (H-04 applies to public + tool inputs).
import { Type, type Static } from 'typebox';
import { ErrorCodeSchema, TicketViewSchema, UUID_PATTERN } from '../web/index.ts';
import { EVENT_PAYLOAD_SCHEMAS, QuoteId, EventEnvelope, type EventType } from './events.ts';
import { EVENT_WRITE_POLICY } from './whitelist.ts';

const strict = { additionalProperties: false } as const;
const Str = () => Type.String({ minLength: 1 });
const Digits = () => Type.String({ pattern: '^[0-9]+$', maxLength: 18 }); // query/header values are strings (A-01 §4.1)
const UUID = Type.String({ pattern: UUID_PATTERN }); // M-15

/** Max request body for emitEvent (A-01 §5.1 step 1) and hands execute (A-01 §5.5). */
export const MAX_EMIT_BODY_BYTES = 64 * 1024;
export const MAX_HANDS_BODY_BYTES = 16 * 1024;

// ---- error envelope (all services) ----
export const ApiError = Type.Object(
  {
    error: Type.Object(
      { code: ErrorCodeSchema, message: Type.String(), details: Type.Optional(Type.Unknown()), traceId: Str() },
      strict,
    ),
  },
  strict,
);
export type ApiError = Static<typeof ApiError>;

// ---- headers ----
export const HEADER = {
  authorization: 'authorization',
  leaseFence: 'x-lease-fence',
  traceparent: 'traceparent',
  traceId: 'x-trace-id',
} as const;
export const LeaseFenceHeader = Type.Object({ 'x-lease-fence': Digits() }, { additionalProperties: true });

// ---- session API (gateway:8081, harness only) ----
export const SessionParams = Type.Object({ id: UUID }, strict);
export const GetSessionResponse = Type.Object(
  { id: UUID, locale: Type.Union([Type.Literal('zh'), Type.Literal('en')]), lastSeq: Type.Integer({ minimum: 0 }) },
  strict, // no userId (A-01 §5.1)
);
export type GetSessionResponse = Static<typeof GetSessionResponse>;

export const GetEventsQuery = Type.Object(
  { afterSeq: Type.Optional(Digits()), limit: Type.Optional(Digits()) },
  strict,
);
export const MAX_EVENTS_PAGE = 500;
export const GetEventsResponse = Type.Object({ events: Type.Array(EventEnvelope), hasMore: Type.Boolean() }, strict);
export type GetEventsResponse = Static<typeof GetEventsResponse>;

/** Types the session API accepts from harness = every durable type whose whitelisted writer is harness. */
const HARNESS_TYPES = (Object.keys(EVENT_PAYLOAD_SCHEMAS) as EventType[]).filter(
  (t) => EVENT_WRITE_POLICY[t].writer === 'harness',
);
/** POST /internal/v1/sessions/:id/events body: one event at a time (O-2). actor/seq/ts are never client-set. */
export const EmitEventRequest = Type.Union(
  HARNESS_TYPES.map((t) =>
    Type.Object({ type: Type.Literal(t), payload: EVENT_PAYLOAD_SCHEMAS[t], idempotencyKey: Str() }, strict),
  ),
);
export type EmitEventRequest = {
  [T in EventType]: (typeof EVENT_WRITE_POLICY)[T] extends { writer: 'harness' }
    ? { type: T; payload: Static<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>; idempotencyKey: string }
    : never;
}[EventType];

export const EmitEventResponse = Type.Union([
  Type.Object({ seq: Type.Integer({ minimum: 1 }), id: UUID }, strict), // 201
  Type.Object({ seq: Type.Integer({ minimum: 1 }), id: UUID, deduplicated: Type.Literal(true) }, strict), // 200
]);
export type EmitEventResponse = Static<typeof EmitEventResponse>;

export const HandsTokenResponse = Type.Object({ token: Str(), expiresAt: Str() }, strict);
export type HandsTokenResponse = Static<typeof HandsTokenResponse>;

// ---- booking API (booking:8083, gateway only) ----
export const CreateBookingRequest = Type.Object({ quoteId: QuoteId, userId: UUID, requestId: Str() }, strict);
export type CreateBookingRequest = Static<typeof CreateBookingRequest>;

// M-12: the ticket in booking responses is web's TicketView (no server-side copy of the quote or ticket shape).
export const CreateBookingResponse = Type.Union([
  Type.Object({ ticket: TicketViewSchema }, strict), // 201
  Type.Object({ ticket: TicketViewSchema, alreadyBooked: Type.Literal(true) }, strict), // 200
]);
export type CreateBookingResponse = Static<typeof CreateBookingResponse>;

// ---- hands API: the execute(name, input) envelope lives ONLY in @fb/contracts/tools (M-12, CONTRACT §1.1) ----
