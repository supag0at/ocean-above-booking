// Error codes: the single definition (M-12). A-01 §4.6 (19 codes, with HTTP statuses) plus the agent-side
// codes of A-02 §5.3. Rule "same name, same meaning" (S-8). tools and server import this enum.
import { Type, type Static } from 'typebox';

export const ErrorCode = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CSRF_INVALID: 'CSRF_INVALID',
  FORBIDDEN_PEER: 'FORBIDDEN_PEER',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  MEMORY_NOT_FOUND: 'MEMORY_NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  QUOTE_NOT_OFFERED: 'QUOTE_NOT_OFFERED',
  BOOKING_UNAVAILABLE: 'BOOKING_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // internal-API-only codes, but A-01 §4.6 puts them in the same enum
  FENCE_STALE: 'FENCE_STALE',
  EVENT_TYPE_FORBIDDEN: 'EVENT_TYPE_FORBIDDEN',
  EVENT_INVALID: 'EVENT_INVALID',
  SERVICE_AUTH_INVALID: 'SERVICE_AUTH_INVALID',
  SESSION_INACTIVE: 'SESSION_INACTIVE',
  INTERNAL: 'INTERNAL',
  // M-12: agent-side codes (A-02 §5.3) live in the same enum, because agent.run_failed.code and
  // booking.failed.code are ErrorCodes in the public view. They have no HTTP status (see HttpErrorCode).
  CITY_NOT_FOUND: 'CITY_NOT_FOUND',
  CITY_AMBIGUOUS: 'CITY_AMBIGUOUS',
  CITY_NOT_SERVED: 'CITY_NOT_SERVED',
  SAME_CITY: 'SAME_CITY',
  NO_ROUTE: 'NO_ROUTE',
  QUOTE_ALREADY_BOOKED: 'QUOTE_ALREADY_BOOKED',
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TOOL_BUDGET_EXCEEDED: 'TOOL_BUDGET_EXCEEDED',
  HANDS_UNAVAILABLE: 'HANDS_UNAVAILABLE',
  HANDS_AUTH: 'HANDS_AUTH',
  LLM_ERROR: 'LLM_ERROR',
  LLM_LENGTH: 'LLM_LENGTH',
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  RESTART_LIMIT: 'RESTART_LIMIT',
  CONTEXT_CORRUPT: 'CONTEXT_CORRUPT',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeSchema = Type.Union(Object.values(ErrorCode).map((c) => Type.Literal(c)));

/** Agent-side codes (A-02 §5.3) that A-01 §4.6 does not list: they never appear as an HTTP status. */
export type AgentOnlyErrorCode = Exclude<
  ErrorCode,
  | 'AUTH_REQUIRED'
  | 'CSRF_INVALID'
  | 'FORBIDDEN_PEER'
  | 'VALIDATION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SESSION_NOT_FOUND'
  | 'QUOTE_NOT_FOUND'
  | 'TICKET_NOT_FOUND'
  | 'MEMORY_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUOTE_NOT_OFFERED'
  | 'BOOKING_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'FENCE_STALE'
  | 'EVENT_TYPE_FORBIDDEN'
  | 'EVENT_INVALID'
  | 'SERVICE_AUTH_INVALID'
  | 'SESSION_INACTIVE'
  | 'INTERNAL'
>;
/** The 19 codes of A-01 §4.6, i.e. the ones that have an HTTP status. */
export type HttpErrorCode = Exclude<ErrorCode, AgentOnlyErrorCode>;

/** HTTP status per A-01 §4.6 code. */
export const ERROR_HTTP_STATUS: Readonly<Record<HttpErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  CSRF_INVALID: 403,
  FORBIDDEN_PEER: 403,
  VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  SESSION_NOT_FOUND: 404,
  QUOTE_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  MEMORY_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  QUOTE_NOT_OFFERED: 409,
  BOOKING_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  FENCE_STALE: 409,
  EVENT_TYPE_FORBIDDEN: 403,
  EVENT_INVALID: 400,
  SERVICE_AUTH_INVALID: 401,
  SESSION_INACTIVE: 409,
  INTERNAL: 500,
};

/** Error envelope shared by all services (A-01 §4.1, S-1). `message` is an English debug string only. */
export const ApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ErrorCodeSchema,
        message: Type.String(),
        details: Type.Optional(Type.Unknown()),
        traceId: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ApiError = Static<typeof ApiErrorSchema>;
