// Internal event envelope + full payload schemas (A-01 §6.1-§6.3, A-02 §2). Backend only.
// All objects are additionalProperties:false (H-08). Public (browser) views live in @fb/contracts/web, not here.
import { Type, type Static, type TSchema } from 'typebox';
import { idPattern, ID_PREFIX } from './ids.ts';

const strict = { additionalProperties: false } as const;
const Str = (opts: Record<string, unknown> = {}) => Type.String({ minLength: 1, ...opts });
const Seq = () => Type.Integer({ minimum: 1 });

// ---------- shared value types ----------
export const Locale = Type.Union([Type.Literal('zh'), Type.Literal('en')]);
export type Locale = Static<typeof Locale>;

export const QuoteId = Type.String({ pattern: idPattern(ID_PREFIX.quote) });
export const TicketId = Type.String({ pattern: idPattern(ID_PREFIX.ticket) });
export const RunId = Type.String({ pattern: idPattern(ID_PREFIX.run) });

// TODO(T01-REVIEW): ErrorCode is specified in A-01 §4.6 + A-02 §5.3 and is meant to live in @fb/contracts/web
// ("ErrorCode 枚举" in A-01 §1.3). The server entry may not import web, so the union is duplicated here.
// Decide the single home (e.g. a shared internal module re-exported by both entries) so it cannot drift.
export const ERROR_CODES = [
  // A-01 §4.6
  'AUTH_REQUIRED',
  'CSRF_INVALID',
  'FORBIDDEN_PEER',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'SESSION_NOT_FOUND',
  'QUOTE_NOT_FOUND',
  'TICKET_NOT_FOUND',
  'MEMORY_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'QUOTE_NOT_OFFERED',
  'BOOKING_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'FENCE_STALE',
  'EVENT_TYPE_FORBIDDEN',
  'EVENT_INVALID',
  'SERVICE_AUTH_INVALID',
  'SESSION_INACTIVE',
  'INTERNAL',
  // A-02 §5.3 (agent side; same name must mean the same thing)
  'CITY_NOT_FOUND',
  'CITY_AMBIGUOUS',
  'CITY_NOT_SERVED',
  'SAME_CITY',
  'NO_ROUTE',
  'QUOTE_ALREADY_BOOKED',
  'INVALID_INPUT',
  'UNKNOWN_TOOL',
  'TOOL_BUDGET_EXCEEDED',
  'HANDS_UNAVAILABLE',
  'HANDS_AUTH',
  'LLM_ERROR',
  'LLM_LENGTH',
  'RUN_TIMEOUT',
  'RESTART_LIMIT',
  'CONTEXT_CORRUPT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = Type.Union(ERROR_CODES.map((c) => Type.Literal(c)));

export const TEMPLATE_IDS = [
  'llm_unavailable',
  'run_timeout',
  'restart_limit',
  'context_corrupt',
  'turn_limit',
  'guard_fallback',
] as const; // A-02 §12.1
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const TemplateIdSchema = Type.Union(TEMPLATE_IDS.map((t) => Type.Literal(t)));

// TODO(T01-REVIEW): A-02 §3.5 lists which endReason values exist: "stop" | "turn_limit" (run_completed, §2.1).
export const EndReason = Type.Union([Type.Literal('stop'), Type.Literal('turn_limit')]);

/** A-02 §12.1: meta.ending lets crash recovery re-write the ending deterministically. */
export const Ending = Type.Union([
  Type.Object({ kind: Type.Literal('completed'), endReason: EndReason }, strict),
  Type.Object({ kind: Type.Literal('failed'), code: ErrorCodeSchema, retryable: Type.Boolean() }, strict),
]);
export type Ending = Static<typeof Ending>;

/** A-02 §9.3 */
export const ProfileSnapshot = Type.Object(
  {
    homeCity: Type.Optional(Type.Object({ city: Type.String(), served: Type.Boolean() }, strict)),
    preferredLanguage: Type.Optional(Locale),
    frequentRoutes: Type.Array(
      Type.Object({ from: Type.String(), to: Type.String(), count: Type.Integer({ minimum: 1 }) }, strict),
      { maxItems: 3 },
    ),
    lastTicket: Type.Optional(Type.Object({ from: Type.String(), to: Type.String(), bookedAt: Type.String() }, strict)),
    ticketCount: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export type ProfileSnapshot = Static<typeof ProfileSnapshot>;

/** A-02 §2.1 UsageSummary */
export const UsageSummary = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    cacheReadTokens: Type.Integer({ minimum: 0 }),
    reasoningTokens: Type.Integer({ minimum: 0 }),
    requests: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
  },
  strict,
);
export type UsageSummary = Static<typeof UsageSummary>;

/** A-01 §4.5 TicketSummary: copied from the quote's display, no freshly computed numbers. */
export const TicketSummary = Type.Object(
  {
    ticketNo: Str(),
    from: Str(),
    to: Str(),
    legs: Type.Array(Type.Object({ from: Str(), to: Str() }, strict)),
    transferCities: Type.Array(Str()),
    display: Type.Object(
      { legs: Type.Array(Type.String()), totalDistanceKm: Type.String(), priceUsd: Type.String() },
      strict,
    ),
  },
  strict,
);
export type TicketSummary = Static<typeof TicketSummary>;

// ---------- durable event payloads ----------
export const UserMessagePayload = Type.Object({ text: Type.String(), clientMessageId: Str() }, strict);

export const QuoteOfferedPayload = Type.Object({ runId: RunId, quoteId: QuoteId, toolCallId: Str() }, strict); // no numbers

export const BookingConfirmedPayload = Type.Object(
  { quoteId: QuoteId, ticketId: TicketId, ticketNo: Str(), summary: TicketSummary },
  strict,
);
export const BookingFailedPayload = Type.Object({ quoteId: QuoteId, code: ErrorCodeSchema }, strict);

export const AgentRunStartedPayload = Type.Object(
  {
    runId: RunId,
    inputSeqs: Type.Array(Seq(), { minItems: 1 }),
    consumedUpToSeq: Seq(), // = max(inputSeqs); gateway validates (A-01 §5.1 step 1)
    lang: Locale,
    today: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    profile: ProfileSnapshot,
    model: Str(),
    promptVersion: Str(),
    projectorVersion: Str(),
    piVersion: Str(),
  },
  strict,
);

export const AgentRunResumedPayload = Type.Object({ runId: RunId, attempt: Type.Integer({ minimum: 2 }) }, strict);

/**
 * A-02 §2.1/§2.3 + M-3 (`processText`, M-2: stored verbatim, NOT masked).
 * TODO(T01-REVIEW): the role-dependent rules ("assistant MUST carry hasToolCalls/viewText"; toolCallId/toolName/isError
 * only for toolResult; processText only for assistant with hasToolCalls:true and then viewText must be "") are not
 * expressible in one flat strict object without a per-role union; they are left to gateway's EVENT_INVALID checks.
 * Say if a role-discriminated union is wanted instead.
 */
export const AgentMessagePayload = Type.Object(
  {
    runId: RunId,
    attempt: Type.Integer({ minimum: 1 }),
    n: Type.Optional(Type.Integer({ minimum: 0 })),
    messageKey: Str(),
    role: Type.Union([Type.Literal('system'), Type.Literal('assistant'), Type.Literal('toolResult')]),
    messageJson: Type.String(), // opaque verbatim pi message; gateway never parses it
    piVersion: Str(),
    viewText: Type.Optional(Type.String()),
    hasToolCalls: Type.Optional(Type.Boolean()),
    toolCallId: Type.Optional(Str()),
    toolName: Type.Optional(Str()),
    isError: Type.Optional(Type.Boolean()),
    data: Type.Optional(Type.Unknown()),
    fill: Type.Optional(Type.Union([Type.Literal('replayed'), Type.Literal('interrupted')])),
    meta: Type.Optional(Type.Object({ template: TemplateIdSchema, ending: Ending }, strict)),
    processText: Type.Optional(Type.String()), // M-2/M-3
  },
  strict,
);

export const AgentGuardViolationPayload = Type.Object(
  {
    runId: RunId,
    attempt: Type.Integer({ minimum: 1 }),
    n: Type.Integer({ minimum: 0 }),
    messageKey: Str(),
    guard: Type.Union([Type.Literal('number'), Type.Literal('booking_claim'), Type.Literal('tag')]),
    offending: Type.Array(Type.String()),
    action: Type.Union([Type.Literal('regenerate'), Type.Literal('replaced')]), // M-5: no 'stripped'
  },
  strict,
);

export const AgentRunCompletedPayload = Type.Object(
  { runId: RunId, endReason: EndReason, usage: UsageSummary },
  strict,
);
export const AgentRunFailedPayload = Type.Object(
  { runId: RunId, code: ErrorCodeSchema, retryable: Type.Boolean() },
  strict,
);

export const AgentContextCompactedPayload = Type.Object(
  {
    compactionId: Str(),
    boundaryRunId: RunId,
    summaryText: Type.String(),
    summaryVersion: Type.Integer({ minimum: 1 }),
    estBefore: Type.Integer({ minimum: 0 }),
    estAfter: Type.Integer({ minimum: 0 }),
  },
  strict,
);

/** Durable event type -> full payload schema. Single source for the union, the whitelist keys and the API. */
export const EVENT_PAYLOAD_SCHEMAS = {
  'user.message': UserMessagePayload,
  'quote.offered': QuoteOfferedPayload,
  'booking.confirmed': BookingConfirmedPayload,
  'booking.failed': BookingFailedPayload,
  'agent.run_started': AgentRunStartedPayload,
  'agent.run_resumed': AgentRunResumedPayload,
  'agent.message': AgentMessagePayload,
  'agent.guard_violation': AgentGuardViolationPayload,
  'agent.run_completed': AgentRunCompletedPayload,
  'agent.run_failed': AgentRunFailedPayload,
  'agent.context_compacted': AgentContextCompactedPayload,
} as const;
export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOAD_SCHEMAS) as EventType[];
export type PayloadOf<T extends EventType> = Static<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

// ---------- ephemeral payloads (A-02 §2.2/§2.2a, M-4) ----------
export const AgentDeltaPayload = Type.Union([
  Type.Object({ runId: RunId, messageKey: Str(), textDelta: Type.String() }, strict),
  Type.Object({ runId: RunId, messageKey: Str(), reset: Type.Literal(true) }, strict),
]);
/** M-4: <= 4 KB per event (UTF-8 bytes is enforced by the sender; schema bounds chars as a cheap guard). */
export const AgentReasoningDeltaPayload = Type.Object(
  { runId: RunId, messageKey: Str(), textDelta: Type.String({ maxLength: 4096 }) },
  strict,
);
export const AgentToolStatusPayload = Type.Object(
  {
    runId: RunId,
    toolCallId: Str(),
    name: Str(),
    phase: Type.Union([Type.Literal('start'), Type.Literal('end')]),
    isError: Type.Optional(Type.Boolean()),
  },
  strict,
);

export const EPHEMERAL_PAYLOAD_SCHEMAS = {
  'agent.delta': AgentDeltaPayload,
  'agent.reasoning_delta': AgentReasoningDeltaPayload,
  'agent.tool_status': AgentToolStatusPayload,
} as const;
export type EphemeralType = keyof typeof EPHEMERAL_PAYLOAD_SCHEMAS;
export const EPHEMERAL_TYPES = Object.keys(EPHEMERAL_PAYLOAD_SCHEMAS) as EphemeralType[];
export type EphemeralPayloadOf<T extends EphemeralType> = Static<(typeof EPHEMERAL_PAYLOAD_SCHEMAS)[T]>;

// ---------- envelopes ----------
export const Actor = Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')]);
export type Actor = Static<typeof Actor>;

/** Which actor an event type carries (A-01 §6.2: set by gateway from the call source, never by the writer). */
export const EVENT_ACTOR: Record<EventType, Actor> = {
  'user.message': 'user',
  'quote.offered': 'agent',
  'booking.confirmed': 'system',
  'booking.failed': 'system',
  'agent.run_started': 'agent',
  'agent.run_resumed': 'agent',
  'agent.message': 'agent',
  'agent.guard_violation': 'agent',
  'agent.run_completed': 'agent',
  'agent.run_failed': 'agent',
  'agent.context_compacted': 'agent',
};

// TODO(T01-REVIEW): A-01 §6.1 says `id: string // uuid`, while A-01 §3.2 events.id is uuid. Pattern-checked (not
// `format:'uuid'`) so validation does not depend on TypeBox's format registry.
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const IsoTs = Type.String({ minLength: 20, maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T' });

const envelopeBase = {
  id: Type.String({ pattern: UUID_PATTERN }),
  sessionId: Type.String({ pattern: UUID_PATTERN }),
  seq: Seq(),
  ts: IsoTs,
  traceId: Str(),
  idempotencyKey: Str(),
  schemaVersion: Type.Literal(1),
};

function envelopeFor<T extends EventType>(type: T): TSchema {
  return Type.Object(
    {
      ...envelopeBase,
      type: Type.Literal(type),
      actor: Type.Literal(EVENT_ACTOR[type]),
      payload: EVENT_PAYLOAD_SCHEMAS[type],
    },
    strict,
  );
}

type EnvelopeOf<T extends EventType> = {
  id: string;
  sessionId: string;
  seq: number;
  type: T;
  actor: Actor;
  ts: string;
  traceId: string;
  idempotencyKey: string;
  schemaVersion: 1;
  payload: PayloadOf<T>;
};
/** Generic accessor kept for A-01 §6.1 parity: EventEnvelope<'agent.message'> etc. */
export type EventEnvelopeOf<T extends EventType = EventType> = T extends EventType ? EnvelopeOf<T> : never;

/** Discriminated (by `type`) union of all durable envelopes. */
export const EventEnvelope = Type.Union(EVENT_TYPES.map((t) => envelopeFor(t)));
export type EventEnvelope = EventEnvelopeOf;

// TODO(T01-REVIEW): A-02 §2.2 says every ephemeral envelope carries the current fence (gateway drops stale ones),
// but A-01 §6.1's EphemeralEnvelope has no `fence` field. Added `fence` here (A-02 wins: it owns ephemeral events).
export const EphemeralEnvelope = Type.Union(
  EPHEMERAL_TYPES.map((t) =>
    Type.Object(
      {
        sessionId: Type.String({ pattern: UUID_PATTERN }),
        type: Type.Literal(t),
        ts: IsoTs,
        traceId: Str(),
        fence: Type.Integer({ minimum: 0 }),
        payload: EPHEMERAL_PAYLOAD_SCHEMAS[t],
      },
      strict,
    ),
  ),
);
export type EphemeralEnvelope = {
  [T in EphemeralType]: {
    sessionId: string;
    type: T;
    ts: string;
    traceId: string;
    fence: number;
    payload: EphemeralPayloadOf<T>;
  };
}[EphemeralType];

/** Doorbell job (A-01 §7.3): carries no work description. */
export const WakeJob = Type.Object({ sessionId: Type.String({ pattern: UUID_PATTERN }), traceparent: Str() }, strict);
export type WakeJob = Static<typeof WakeJob>;
