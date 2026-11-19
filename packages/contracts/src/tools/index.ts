// @fb/contracts/tools: LLM tool definitions, the hands `execute` envelope and agent-side error codes.
// Sources: A-02 §5.1-§5.3, §7.0-§7.5; CONTRACT-v1 §1.2, §2 (M-6), §3, §4 (CT-01, CT-02, CT-08).
// Only dependency: typebox. No IO, no imports from other contract entries.
//
// Schema rules: every object has `additionalProperties:false` (D-24); no `Type.Never` (DeepSeek
// compatibility); no identity fields anywhere (H-04: identity comes from the hands token).
import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';

// ---------------------------------------------------------------------------------------------
// Agent-side error codes (A-02 §5.3)
// ---------------------------------------------------------------------------------------------

export const AGENT_ERROR_CODES = [
  // hands
  'CITY_NOT_FOUND',
  'CITY_AMBIGUOUS',
  'CITY_NOT_SERVED',
  'SAME_CITY',
  'NO_ROUTE',
  'QUOTE_NOT_FOUND',
  'QUOTE_ALREADY_BOOKED',
  // hands or harness
  'INVALID_INPUT',
  'IDEMPOTENCY_CONFLICT',
  'UNKNOWN_TOOL',
  // harness
  'TOOL_BUDGET_EXCEEDED',
  'HANDS_UNAVAILABLE',
  'HANDS_AUTH',
  'LLM_ERROR',
  'LLM_LENGTH',
  'RUN_TIMEOUT',
  'RESTART_LIMIT',
  'CONTEXT_CORRUPT',
  'FENCE_STALE',
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** Codes hands may return inside `{ ok:false, error }` (everything else is raised by the harness). */
export const HANDS_ERROR_CODES = [
  'CITY_NOT_FOUND',
  'CITY_AMBIGUOUS',
  'CITY_NOT_SERVED',
  'SAME_CITY',
  'NO_ROUTE',
  'QUOTE_NOT_FOUND',
  'QUOTE_ALREADY_BOOKED',
  'INVALID_INPUT',
  'IDEMPOTENCY_CONFLICT',
  'UNKNOWN_TOOL',
] as const satisfies readonly AgentErrorCode[];

// ---------------------------------------------------------------------------------------------
// Text sent to the LLM for a tool result (A-02 §5.1 table). The model only sees text, so success and
// failure are told apart by these fixed prefixes.
// ---------------------------------------------------------------------------------------------

/** Business error: `ERROR {code}: {error.llmText}` */
export const LLM_PREFIX_ERROR = 'ERROR ';
/** Blocked by the harness: `BLOCKED {code}: {explanation}` */
export const LLM_PREFIX_BLOCKED = 'BLOCKED ';
/** Run recovered after a crash: `INTERRUPTED: ...` */
export const LLM_PREFIX_INTERRUPTED = 'INTERRUPTED: ';
export const LLM_TEXT_HANDS_UNAVAILABLE =
  'ERROR HANDS_UNAVAILABLE: Tool temporarily unavailable. Tell the user to retry shortly.';

/** System calls start with this prefix and are NEVER put in the tool list given to pi (A-02 §5.2). */
export const SYS_CALL_PREFIX = 'sys.';
export const SYS_PROFILE_SNAPSHOT = 'sys.profile_snapshot';

// ---------------------------------------------------------------------------------------------
// Idempotency keys (CONTRACT-v1 §2 M-6). Pure string builders, no IO.
// ---------------------------------------------------------------------------------------------

/** `quote.offered` idempotencyKey */
export function quoteOfferedIdempotencyKey(runId: string, toolCallId: string): string {
  return `offer:${runId}:${toolCallId}`;
}
/** toolResult messageKey */
export function toolResultMessageKey(runId: string, toolCallId: string): string {
  return `msg:tr:${runId}:${toolCallId}`;
}
// hands-side key is the tuple (session_id, run_id, tool_call_id); see ExecuteRequest.

// ---------------------------------------------------------------------------------------------
// execute envelope (A-02 §5.1)
// ---------------------------------------------------------------------------------------------

export const ExecuteRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    /** Raw tool arguments. Validated per tool by hands (TypeBox `Value.Check`, no coercion). */
    input: Type.Record(Type.String(), Type.Unknown()),
    toolCallId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    /**
     * Largest seq among the run's inputSeqs (the last user.message). hands writes it to
     * user_memories.source_seq and checks 1 <= inputSeq <= last_user_seq. On resume use the same value.
     */
    inputSeq: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ExecuteRequest = Static<typeof ExecuteRequestSchema>;

const ErrorCodeSchema = Type.Union(AGENT_ERROR_CODES.map((c) => Type.Literal(c)));

export const ExecuteOkResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    llmText: Type.String(),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ExecuteErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object(
      {
        code: ErrorCodeSchema,
        llmText: Type.String(),
        data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ExecuteResponseSchema = Type.Union([ExecuteOkResponseSchema, ExecuteErrorResponseSchema]);
export type ExecuteOkResponse = Static<typeof ExecuteOkResponseSchema>;
export type ExecuteErrorResponse = Static<typeof ExecuteErrorResponseSchema>;
export type ExecuteResponse = ExecuteOkResponse | ExecuteErrorResponse;

/** Retries for 5xx / network errors with the same toolCallId (A-02 §5.1). */
export const EXECUTE_RETRY_DELAYS_MS = [200, 800] as const;

// ---------------------------------------------------------------------------------------------
// Shared data fragments
// ---------------------------------------------------------------------------------------------

const NearestServedSchema = Type.Object(
  { city: Type.String(), distanceKm: Type.String() },
  { additionalProperties: false },
);

const LegSchema = Type.Object(
  { from: Type.String(), to: Type.String(), distanceKm: Type.Number() },
  { additionalProperties: false },
);

const RouteDisplaySchema = Type.Object(
  {
    legs: Type.Array(Type.String()),
    totalDistanceKm: Type.String(),
    priceUsd: Type.String(),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------------

export type ToolExecutionMode = 'parallel' | 'sequential';

export interface ToolDefinition<P extends TSchema = TSchema, D extends TSchema = TSchema> {
  readonly name: string;
  /** For the LLM. English, short. */
  readonly description: string;
  /** Strict input schema (additionalProperties:false, no Never, no identity fields). */
  readonly parameters: P;
  /** Schema of `data` in `{ ok:true, data }`. */
  readonly data: D;
  /** Convention for `llmText` of a successful call (documentation, not validated). */
  readonly llmText: string;
  /** D-44: side-effecting tools are `sequential`, the rest `parallel`. */
  readonly executionMode: ToolExecutionMode;
}

// resolve_city -------------------------------------------------------------------------------
export const ResolveCityParams = Type.Object(
  {
    original: Type.String({ minLength: 1, maxLength: 80, description: "The user's original wording, any language." }),
    candidates: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      minItems: 1,
      maxItems: 3,
      description: 'One to three English city names, most likely first. Case and accents do not matter.',
    }),
  },
  { additionalProperties: false },
);
export type ResolveCityParamsT = Static<typeof ResolveCityParams>;

const CityMatchSchema = Type.Object(
  {
    city: Type.String(),
    isHub: Type.Boolean(),
    served: Type.Boolean(),
    connectedHubs: Type.Array(Type.String()),
    nearestServed: Type.Union([NearestServedSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ResolveCityData = Type.Object(
  {
    status: Type.Union([
      Type.Literal('exact'),
      Type.Literal('ambiguous'),
      Type.Literal('suggest'),
      Type.Literal('not_found'),
    ]),
    matches: Type.Array(CityMatchSchema, { maxItems: 5 }),
    // TODO(T01-REVIEW): A-02 §7.1 shows matchedBy unconditionally, but for not_found there is nothing
    // to point at; made optional here.
    matchedBy: Type.Optional(
      Type.Object(
        {
          source: Type.Union([Type.Literal('candidate'), Type.Literal('original'), Type.Literal('fuzzy')]),
          index: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ResolveCityDataT = Static<typeof ResolveCityData>;

export const resolveCityTool = {
  name: 'resolve_city',
  description:
    'Look up a city name in the flight network. Pass the user wording as original plus 1-3 English candidate names. Returns exact, ambiguous, suggest or not_found, and the nearest served city if the match has no flights.',
  parameters: ResolveCityParams,
  data: ResolveCityData,
  llmText:
    "Status line, e.g. 'exact: Austin (NOT served). Nearest served city: Copenhagen (120.95 km away).' / 'ambiguous: ...' / 'suggest: ...' / 'not_found: ...'",
  executionMode: 'parallel',
} as const satisfies ToolDefinition;

// quote_route --------------------------------------------------------------------------------
export const QuoteRouteParams = Type.Object(
  {
    from: Type.String({ minLength: 1, maxLength: 80, description: 'Exact city name as returned by resolve_city.' }),
    to: Type.String({ minLength: 1, maxLength: 80, description: 'Exact city name as returned by resolve_city.' }),
  },
  { additionalProperties: false },
);
export type QuoteRouteParamsT = Static<typeof QuoteRouteParams>;

export const QuoteRouteData = Type.Object(
  {
    quoteId: Type.String(),
    from: Type.String(),
    to: Type.String(),
    legs: Type.Array(LegSchema),
    transferCities: Type.Array(Type.String()),
    totalDistanceKm: Type.Number(),
    priceCents: Type.Integer({ minimum: 0 }),
    display: RouteDisplaySchema,
    dataSha256: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type QuoteRouteDataT = Static<typeof QuoteRouteData>;

export const quoteRouteTool = {
  name: 'quote_route',
  description:
    'Create a price quote for the cheapest route between two exact city names. The quote card with distance and price is shown to the user directly; do not state numbers yourself.',
  parameters: QuoteRouteParams,
  data: QuoteRouteData,
  llmText:
    'Deliberately number-free: "Quote q_... created: A -> B -> C (2 legs, 1 transfer at B). Distance and price are shown to the user on the quote card. ..."',
  executionMode: 'parallel',
} as const satisfies ToolDefinition;

// offer_booking ------------------------------------------------------------------------------
export const OfferBookingParams = Type.Object(
  {
    // Loose bound on purpose: the id format (q_<ULID>) is hands' business, a wrong id gives QUOTE_NOT_FOUND.
    quoteId: Type.String({ minLength: 1, maxLength: 64, description: 'Id of an existing quote.' }),
  },
  { additionalProperties: false },
);
export type OfferBookingParamsT = Static<typeof OfferBookingParams>;

export const OfferBookingData = Type.Object(
  { quoteId: Type.String(), offered: Type.Literal(true) },
  { additionalProperties: false },
);
export type OfferBookingDataT = Static<typeof OfferBookingData>;

export const offerBookingTool = {
  name: 'offer_booking',
  description:
    'Show the user a booking card for an existing quote when they want to go ahead. The user must click the button on the card themselves; this tool cannot complete anything.',
  parameters: OfferBookingParams,
  data: OfferBookingData,
  llmText:
    '"Booking card shown for q_.... The user must click the confirm button on the card to book. You cannot book on their behalf."',
  executionMode: 'sequential',
} as const satisfies ToolDefinition;

// list_my_tickets ----------------------------------------------------------------------------
export const ListMyTicketsParams = Type.Object(
  {
    city: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        description: 'Exact city name; matches tickets with any leg endpoint there.',
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  },
  { additionalProperties: false },
);
export type ListMyTicketsParamsT = Static<typeof ListMyTicketsParams>;

// TODO(T01-REVIEW): A-02 §7.4 only lists the ticket field names, not their types or whether
// transferCities is included. Types below mirror Quote (§7.2); confirm.
const TicketSchema = Type.Object(
  {
    ticketId: Type.String(),
    ticketNo: Type.String(),
    bookedAt: Type.String(),
    from: Type.String(),
    to: Type.String(),
    legs: Type.Array(LegSchema),
    totalDistanceKm: Type.Number(),
    priceCents: Type.Integer({ minimum: 0 }),
    display: RouteDisplaySchema,
  },
  { additionalProperties: false },
);

export const ListMyTicketsData = Type.Object(
  { tickets: Type.Array(TicketSchema), total: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type ListMyTicketsDataT = Static<typeof ListMyTicketsData>;

export const listMyTicketsTool = {
  name: 'list_my_tickets',
  description: 'List the current user own tickets, newest first. Optionally filter by a city or limit the count.',
  parameters: ListMyTicketsParams,
  data: ListMyTicketsData,
  llmText:
    '"3 tickets (newest first): [OA-... 2026-11-18] A->B->C, 18000.00 km, USD 2340.00; ..." Numbers equal data.display exactly, so the number guard lets the model quote them.',
  executionMode: 'parallel',
} as const satisfies ToolDefinition;

// save_preference / forget_preference -------------------------------------------------------
export const PREFERENCE_KEYS = ['home_city', 'preferred_language'] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const SavePreferenceParams = Type.Union([
  Type.Object(
    {
      key: Type.Literal('home_city'),
      value: Type.String({
        minLength: 1,
        maxLength: 80,
        description: 'City name; hands normalises it to the exact name.',
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      key: Type.Literal('preferred_language'),
      value: Type.Union([Type.Literal('zh'), Type.Literal('en')]),
    },
    { additionalProperties: false },
  ),
]);
export type SavePreferenceParamsT = Static<typeof SavePreferenceParams>;

export const ForgetPreferenceParams = Type.Object(
  { key: Type.Union([Type.Literal('home_city'), Type.Literal('preferred_language')]) },
  { additionalProperties: false },
);
export type ForgetPreferenceParamsT = Static<typeof ForgetPreferenceParams>;

// TODO(T01-REVIEW): A-02 §7.5 defines only llmText for these two tools, not `data`. Proposal: echo
// the stored key/value (value is the canonical city_name for home_city).
export const SavePreferenceData = Type.Object(
  { key: Type.Union([Type.Literal('home_city'), Type.Literal('preferred_language')]), value: Type.String() },
  { additionalProperties: false },
);
export const ForgetPreferenceData = Type.Object(
  { key: Type.Union([Type.Literal('home_city'), Type.Literal('preferred_language')]) },
  { additionalProperties: false },
);

export const savePreferenceTool = {
  name: 'save_preference',
  description:
    'Remember a user preference (home_city or preferred_language). Only call when the user explicitly states it in the current message. City values must be resolved first.',
  parameters: SavePreferenceParams,
  data: SavePreferenceData,
  llmText:
    '"Saved: home_city = Sao Paulo." Errors: INVALID_INPUT (not an exact city name, with candidates), CITY_AMBIGUOUS.',
  executionMode: 'sequential',
} as const satisfies ToolDefinition;

export const forgetPreferenceTool = {
  name: 'forget_preference',
  description: 'Forget a previously saved user preference (home_city or preferred_language).',
  parameters: ForgetPreferenceParams,
  data: ForgetPreferenceData,
  // TODO(T01-REVIEW): no llmText example for forget_preference in A-02 §7.5; this one is invented.
  llmText: '"Forgot: home_city."',
  executionMode: 'sequential',
} as const satisfies ToolDefinition;

// ---------------------------------------------------------------------------------------------

/** The complete tool list handed to pi. Never contains `sys.*` calls. */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  resolveCityTool,
  quoteRouteTool,
  offerBookingTool,
  listMyTicketsTool,
  savePreferenceTool,
  forgetPreferenceTool,
];

export type ToolName =
  | typeof resolveCityTool.name
  | typeof quoteRouteTool.name
  | typeof offerBookingTool.name
  | typeof listMyTicketsTool.name
  | typeof savePreferenceTool.name
  | typeof forgetPreferenceTool.name;
