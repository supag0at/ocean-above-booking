// Error codes (A-01 §4.6). Rule "same name, same meaning" (S-8).
// Source of truth: A-01 §4.6 table. HTTP statuses are exported alongside so that
// the gateway and the frontend mock share one mapping.
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
  // TODO(T01-REVIEW): A-02 §5.3 agent-side codes (CITY_NOT_FOUND, LLM_ERROR, RUN_TIMEOUT, ...) must
  // also be merged into "the same ErrorCode enum" (A-01 §4.6) because agent.run_failed.code is an
  // ErrorCode, but CONTRACT §1.1 puts agent-side codes in @fb/contracts/tools. Not included here;
  // see RunFailedPayloadSchema.code (plain string) in events.ts.
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeSchema = Type.Union(Object.values(ErrorCode).map((c) => Type.Literal(c)));

/** HTTP status per code (A-01 §4.6). */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
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
