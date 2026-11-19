// Internal HTTP API schemas: session API (A-01 §5.1), hands token (§5.3), booking API (§5.4), hands execute (§5.5,
// A-02 §5.1) and the shared error envelope (A-01 §4.1). Backend only. Requests never carry a user id except
// the booking request, which is gateway -> booking only (H-04 applies to public + tool inputs).
import { Type, type Static } from 'typebox';
import {
  ErrorCodeSchema,
  EVENT_PAYLOAD_SCHEMAS,
  QuoteId,
  RunId,
  TicketId,
  EventEnvelope,
  type EventType,
} from './events.ts';
import { EVENT_WRITE_POLICY } from './whitelist.ts';

const strict = { additionalProperties: false } as const;
const Str = () => Type.String({ minLength: 1 });
const Digits = () => Type.String({ pattern: '^[0-9]+$', maxLength: 18 }); // query/header values are strings (A-01 §4.1)
const UUID = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });

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

// TODO(T01-REVIEW): Quote (A-02 §7.2) and TicketView (A-01 §4.5) belong to flight/web contracts. Duplicated here
// structurally only because the server entry may not import web; keep in sync or move Quote to a shared internal module.
export const QuoteSnapshot = Type.Object(
  {
    quoteId: QuoteId,
    from: Str(),
    to: Str(),
    legs: Type.Array(Type.Object({ from: Str(), to: Str(), distanceKm: Type.Number() }, strict)),
    transferCities: Type.Array(Str()),
    totalDistanceKm: Type.Number(),
    priceCents: Type.Integer({ minimum: 0 }),
    display: Type.Object(
      { legs: Type.Array(Type.String()), totalDistanceKm: Type.String(), priceUsd: Type.String() },
      strict,
    ),
    dataSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    createdAt: Str(),
  },
  strict,
);
export const TicketRecord = Type.Object(
  {
    ticketId: TicketId,
    ticketNo: Str(),
    sessionId: UUID,
    quoteId: QuoteId,
    from: Str(),
    to: Str(),
    itinerary: QuoteSnapshot,
    priceCents: Type.Integer({ minimum: 0 }),
    bookedAt: Str(),
  },
  strict,
);
export type TicketRecord = Static<typeof TicketRecord>;

export const CreateBookingResponse = Type.Union([
  Type.Object({ ticket: TicketRecord }, strict), // 201
  Type.Object({ ticket: TicketRecord, alreadyBooked: Type.Literal(true) }, strict), // 200
]);
export type CreateBookingResponse = Static<typeof CreateBookingResponse>;

// ---- hands API (hands:8082, POST /internal/execute) ----
// TODO(T01-REVIEW): CONTRACT §1.1 puts the execute(name,input) envelope in @fb/contracts/tools (A-02 §5), while
// A-01 §1.3 lists "hands 信封" under server. Defined here for the HTTP layer; T01's tools-entry author should
// either re-export this or own it. `input` is `unknown` here: per-tool strict schemas live in tools.
export const HandsExecuteRequest = Type.Object(
  { name: Str(), input: Type.Unknown(), toolCallId: Str(), runId: RunId, inputSeq: Type.Integer({ minimum: 1 }) },
  strict,
);
export type HandsExecuteRequest = Static<typeof HandsExecuteRequest>;

export const HandsExecuteResponse = Type.Union([
  Type.Object({ ok: Type.Literal(true), llmText: Type.String(), data: Type.Unknown() }, strict),
  Type.Object(
    {
      ok: Type.Literal(false),
      error: Type.Object(
        { code: ErrorCodeSchema, llmText: Type.String(), data: Type.Optional(Type.Unknown()) },
        strict,
      ),
    },
    strict,
  ),
]);
export type HandsExecuteResponse = Static<typeof HandsExecuteResponse>;
