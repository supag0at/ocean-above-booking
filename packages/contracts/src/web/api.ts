// Public REST/SSE request and response schemas (A-01 §4.1, §4.3, §4.4). Prefix /api/v1.
// Request schemas never contain userId (H-04). Query params are strings (pattern-checked and
// converted explicitly by the handler, A-01 §4.1: coerceTypes is off).
import { Type, type Static } from 'typebox';
import { UUID_PATTERN } from './constants.ts';
import { PublicEventSchema } from './events.ts';
import {
  LocaleSchema,
  MemoryViewSchema,
  QuoteViewSchema,
  SessionStatusSchema,
  SessionViewSchema,
  TicketViewSchema,
  UserViewSchema,
} from './views.ts';

const strict = { additionalProperties: false } as const;
const digits = { pattern: '^[0-9]+$' } as const;

export const API_PREFIX = '/api/v1';

// ---- path params ----
export const SessionIdParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) }, strict);
export const QuoteIdParamsSchema = Type.Object({ quoteId: Type.String({ minLength: 1 }) }, strict);
export const TicketIdParamsSchema = Type.Object({ ticketId: Type.String({ minLength: 1 }) }, strict);
export const MemoryIdParamsSchema = Type.Object({ memoryId: Type.String({ minLength: 1 }) }, strict);

// ---- pagination (cursor = base64url JSON {k, i}; limit <= 50 is checked by the handler) ----
export const PageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]+$' })),
    limit: Type.Optional(Type.String(digits)),
  },
  strict,
);
export type PageQuery = Static<typeof PageQuerySchema>;

// ---- auth / me ----
// M-19: two-step username check. Step 1 (this schema): raw length 1..64. Step 2 is the SERVER's job, not
// expressible here: normalize (NFKC + trim + lower), then require 1..32 on the normalized value.
export const LoginBodySchema = Type.Object({ username: Type.String({ minLength: 1, maxLength: 64 }) }, strict);
export type LoginBody = Static<typeof LoginBodySchema>;
export const UserResponseSchema = Type.Object({ user: UserViewSchema }, strict);
export type UserResponse = Static<typeof UserResponseSchema>;
export const PatchMeBodySchema = Type.Object({ locale: LocaleSchema }, strict);
export type PatchMeBody = Static<typeof PatchMeBodySchema>;

// ---- sessions ----
export const SessionsPageSchema = Type.Object(
  { items: Type.Array(SessionViewSchema), nextCursor: Type.Optional(Type.String()) },
  strict,
);
export type SessionsPage = Static<typeof SessionsPageSchema>;
export const CreateSessionBodySchema = Type.Object({ locale: Type.Optional(LocaleSchema) }, strict);
export type CreateSessionBody = Static<typeof CreateSessionBodySchema>;
export const SessionResponseSchema = Type.Object({ session: SessionViewSchema }, strict);
export type SessionResponse = Static<typeof SessionResponseSchema>;

export const EventsQuerySchema = Type.Object(
  { afterSeq: Type.Optional(Type.String(digits)), limit: Type.Optional(Type.String(digits)) },
  strict,
);
export type EventsQuery = Static<typeof EventsQuerySchema>;
export const EventsResponseSchema = Type.Object(
  { events: Type.Array(PublicEventSchema), hasMore: Type.Boolean() },
  strict,
);
export type EventsResponse = Static<typeof EventsResponseSchema>;

/** GET /sessions/:id/stream; the `Last-Event-ID` header is the other way to resume. */
export const StreamQuerySchema = Type.Object({ afterSeq: Type.Optional(Type.String(digits)) }, strict);
export type StreamQuery = Static<typeof StreamQuerySchema>;

// M-15: uuid is a `pattern` (UUID_PATTERN), never `format`, so no ajv-formats is needed.
export const PostMessageBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 2000 }),
    clientMessageId: Type.String({ pattern: UUID_PATTERN }),
  },
  strict,
);
export type PostMessageBody = Static<typeof PostMessageBodySchema>;
/** 202 on first accept, 200 on idempotent replay. */
export const PostMessageResponseSchema = Type.Object({ event: PublicEventSchema }, strict);
export type PostMessageResponse = Static<typeof PostMessageResponseSchema>;

// ---- quotes / tickets ----
export const QuoteResponseSchema = Type.Object({ quote: QuoteViewSchema }, strict);
export type QuoteResponse = Static<typeof QuoteResponseSchema>;
/** POST /quotes/:quoteId/confirm has NO request body (O-3). 201 { ticket }. */
export const ConfirmCreatedResponseSchema = Type.Object({ ticket: TicketViewSchema }, strict);
export type ConfirmCreatedResponse = Static<typeof ConfirmCreatedResponseSchema>;
/** 200 on replay: { ticket, alreadyBooked: true }. */
export const ConfirmReplayResponseSchema = Type.Object(
  { ticket: TicketViewSchema, alreadyBooked: Type.Literal(true) },
  strict,
);
export type ConfirmReplayResponse = Static<typeof ConfirmReplayResponseSchema>;
export const TicketsPageSchema = Type.Object(
  { items: Type.Array(TicketViewSchema), nextCursor: Type.Optional(Type.String()) },
  strict,
);
export type TicketsPage = Static<typeof TicketsPageSchema>;
export const TicketResponseSchema = Type.Object({ ticket: TicketViewSchema }, strict);
export type TicketResponse = Static<typeof TicketResponseSchema>;

// ---- profile / health ----
export const ProfileResponseSchema = Type.Object({ preferences: Type.Array(MemoryViewSchema) }, strict);
export type ProfileResponse = Static<typeof ProfileResponseSchema>;
export const HealthResponseSchema = Type.Object({ ok: Type.Literal(true) }, strict);
export type HealthResponse = Static<typeof HealthResponseSchema>;

// ---- SSE (A-01 §4.4): `event: evt` (id = seq, data PublicEvent), `event: eph` (data PublicEphemeral),
// `event: status` (data below). Heartbeat is a `: ping` comment every 15 s, plus `retry: 3000`.
export const SSE_EVENT_NAMES = { evt: 'evt', eph: 'eph', status: 'status' } as const;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 3000;
export const StatusFrameSchema = Type.Object({ status: SessionStatusSchema }, strict);
export type StatusFrame = Static<typeof StatusFrameSchema>;
