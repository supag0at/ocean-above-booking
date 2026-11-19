// REST view types (A-01 §4.5). Every object: additionalProperties:false (A-01 §4.1, H-08).
import { Type, type Static } from 'typebox';

const strict = { additionalProperties: false } as const;

export const LocaleSchema = Type.Union([Type.Literal('zh'), Type.Literal('en')]);
export type Locale = Static<typeof LocaleSchema>;

/** Display-only session status (A-01 §6.4). */
export const SessionStatusSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('error'),
]);
export type SessionStatus = Static<typeof SessionStatusSchema>;

export const UserViewSchema = Type.Object({ id: Type.String(), username: Type.String(), locale: LocaleSchema }, strict);
export type UserView = Static<typeof UserViewSchema>;

export const SessionViewSchema = Type.Object(
  {
    id: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
    locale: LocaleSchema,
    status: SessionStatusSchema,
    lastSeq: Type.Integer(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type SessionView = Static<typeof SessionViewSchema>;

// M-12: Quote / QuoteLeg / QuoteDisplay / TicketView / TicketSummary are defined ONLY here; flight and server
// import them. Shape per A-02 §7.2. Numbers are API-computed values; the browser never derives them (M-13).
export const QuoteLegSchema = Type.Object(
  { from: Type.String(), to: Type.String(), distanceKm: Type.Number() },
  strict,
);
export type QuoteLeg = Static<typeof QuoteLegSchema>;
export const QuoteDisplaySchema = Type.Object(
  { legs: Type.Array(Type.String()), totalDistanceKm: Type.String(), priceUsd: Type.String() },
  strict,
);
export type QuoteDisplay = Static<typeof QuoteDisplaySchema>;
export const QuoteSchema = Type.Object(
  {
    quoteId: Type.String(),
    from: Type.String(),
    to: Type.String(),
    legs: Type.Array(QuoteLegSchema),
    transferCities: Type.Array(Type.String()),
    totalDistanceKm: Type.Number(),
    priceCents: Type.Integer({ minimum: 0 }),
    display: QuoteDisplaySchema,
    dataSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    createdAt: Type.String(),
  },
  strict,
);
export type Quote = Static<typeof QuoteSchema>;

export const QuoteBookingSchema = Type.Union([
  Type.Object({ status: Type.Literal('available') }, strict),
  Type.Object({ status: Type.Literal('booked'), ticketId: Type.String(), ticketNo: Type.String() }, strict),
]);

export const QuoteViewSchema = Type.Object(
  { sessionId: Type.String(), quote: QuoteSchema, booking: QuoteBookingSchema },
  strict,
);
export type QuoteView = Static<typeof QuoteViewSchema>;

export const TicketViewSchema = Type.Object(
  {
    ticketId: Type.String(),
    ticketNo: Type.String(),
    sessionId: Type.String(),
    quoteId: Type.String(),
    from: Type.String(),
    to: Type.String(),
    itinerary: QuoteSchema,
    priceCents: Type.Integer({ minimum: 0 }),
    bookedAt: Type.String(),
  },
  strict,
);
export type TicketView = Static<typeof TicketViewSchema>;

/** A-01 §4.5 TicketSummary (booking.confirmed payload): copied from the quote's display, no freshly computed numbers. */
export const TicketSummarySchema = Type.Object(
  {
    ticketNo: Type.String({ minLength: 1 }),
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    legs: Type.Array(Type.Object({ from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }) }, strict)),
    transferCities: Type.Array(Type.String({ minLength: 1 })),
    display: QuoteDisplaySchema,
  },
  strict,
);
export type TicketSummary = Static<typeof TicketSummarySchema>;

export const MemoryViewSchema = Type.Object(
  {
    memoryId: Type.String(),
    key: Type.Union([Type.Literal('home_city'), Type.Literal('preferred_language')]),
    value: Type.String(),
    createdAt: Type.String(),
    source: Type.Object({ sessionId: Type.String(), seq: Type.Integer() }, strict),
  },
  strict,
);
export type MemoryView = Static<typeof MemoryViewSchema>;
