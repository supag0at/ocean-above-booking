// Public event views (A-01 §4.5, CONTRACT M-1 / M-2 / M-4). WHITELIST ONLY:
// no messageJson, no thinking blocks, no system-message text, no toolResult `data`,
// no profile / offending / guard / usage / fence / compaction summary.
// This entry deliberately does not export the internal EventEnvelope (I-4).
import { Type, type Static, type TSchema } from 'typebox';
import { ErrorCodeSchema } from './errors.ts';

const strict = { additionalProperties: false } as const;

export const ActorSchema = Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')]);
export type Actor = Static<typeof ActorSchema>;

/** Common envelope fields of a PublicEvent: { seq, type, actor, ts, payload }. */
function pub<const T extends string, P extends TSchema>(type: T, payload: P) {
  return Type.Object(
    {
      seq: Type.Integer(),
      type: Type.Literal(type),
      actor: ActorSchema,
      ts: Type.String(),
      payload,
    },
    strict,
  );
}

export const UserMessagePayloadSchema = Type.Object({ text: Type.String(), clientMessageId: Type.String() }, strict);

/** Final assistant reply (no tool calls). `text` is the guarded `viewText` only. */
export const AgentReplyPayloadSchema = Type.Object(
  {
    runId: Type.String(),
    messageKey: Type.String(),
    kind: Type.Literal('reply'),
    text: Type.String(),
    template: Type.Optional(Type.String()), // from meta.template
  },
  strict,
);

/**
 * Assistant message WITH tool calls (ReAct intermediate step), M-1: kind 'process'.
 * M-2: `processText` is the raw assistant text, NOT masked. Missing upstream = "".
 * Never put this text into `text`.
 */
export const AgentProcessPayloadSchema = Type.Object(
  {
    runId: Type.String(),
    messageKey: Type.String(),
    kind: Type.Literal('process'),
    processText: Type.String(),
  },
  strict,
);

// M-21 (parent ruling, kept as-is): the toolResult variant has no `kind` in A-01 §4.5 / §9.4 (renderers tell it
// apart by the presence of `toolCallId`), so the agent.message union is discriminated by `kind`
// only for reply/process. Not covered by M-1..M-20: add kind:'tool_result' if a uniform discriminator is wanted.
// A-02 §2.1 has `isError?` optional; A-01 §4.5 lists it as always present (gateway defaults false).
export const AgentToolResultPayloadSchema = Type.Object(
  {
    runId: Type.String(),
    messageKey: Type.String(),
    toolCallId: Type.String(),
    toolName: Type.String(),
    isError: Type.Boolean(),
  },
  strict,
);

export const AgentMessagePayloadSchema = Type.Union([
  AgentReplyPayloadSchema,
  AgentProcessPayloadSchema,
  AgentToolResultPayloadSchema,
]);

export const RunStartedPayloadSchema = Type.Object({ runId: Type.String() }, strict);
export const RunResumedPayloadSchema = Type.Object({ runId: Type.String(), attempt: Type.Integer() }, strict);
export const RunCompletedPayloadSchema = Type.Object({ runId: Type.String() }, strict);
// M-12: `code` is the single ErrorCode (A-01 §4.6 + agent-side codes).
export const RunFailedPayloadSchema = Type.Object({ runId: Type.String(), code: ErrorCodeSchema }, strict);
export const GuardViolationPayloadSchema = Type.Object(
  {
    runId: Type.String(),
    messageKey: Type.String(),
    action: Type.Union([Type.Literal('regenerate'), Type.Literal('replaced')]), // M-5
  },
  strict,
);
export const QuoteOfferedPayloadSchema = Type.Object({ quoteId: Type.String() }, strict);
export const BookingConfirmedPayloadSchema = Type.Object(
  { quoteId: Type.String(), ticketId: Type.String(), ticketNo: Type.String() },
  strict,
);
// M-12: `code` is the single ErrorCode.
export const BookingFailedPayloadSchema = Type.Object({ quoteId: Type.String(), code: ErrorCodeSchema }, strict);
/** `hidden`: system messages, compaction events and any unregistered type; only the seq survives. */
export const HiddenPayloadSchema = Type.Object({}, strict);

export const PublicEventSchema = Type.Union([
  pub('user.message', UserMessagePayloadSchema),
  pub('agent.message', AgentMessagePayloadSchema),
  pub('agent.run_started', RunStartedPayloadSchema),
  pub('agent.run_resumed', RunResumedPayloadSchema),
  pub('agent.run_completed', RunCompletedPayloadSchema),
  pub('agent.run_failed', RunFailedPayloadSchema),
  pub('agent.guard_violation', GuardViolationPayloadSchema),
  pub('quote.offered', QuoteOfferedPayloadSchema),
  pub('booking.confirmed', BookingConfirmedPayloadSchema),
  pub('booking.failed', BookingFailedPayloadSchema),
  pub('hidden', HiddenPayloadSchema),
]);
export type PublicEvent = Static<typeof PublicEventSchema>;
export type PublicEventType = PublicEvent['type'];

// ---- ephemeral events (A-01 §4.5 table, A-02 §2.2; M-4: reasoning_delta is NOT masked) ----

const delta = Type.Union([
  Type.Object({ runId: Type.String(), messageKey: Type.String(), textDelta: Type.String() }, strict),
  Type.Object({ runId: Type.String(), messageKey: Type.String(), reset: Type.Literal(true) }, strict),
]);

// M-17: the public ephemeral view is `{ type, payload }` only (no seq, sessionId, traceId or fence; the fence
// lives on the internal envelope in @fb/contracts/server). The 4 KB cap (M-4) is enforced on the internal event.
export const PublicEphemeralSchema = Type.Union([
  Type.Object({ type: Type.Literal('agent.delta'), payload: delta }, strict),
  Type.Object(
    {
      type: Type.Literal('agent.reasoning_delta'),
      payload: Type.Object({ runId: Type.String(), messageKey: Type.String(), textDelta: Type.String() }, strict),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal('agent.tool_status'),
      payload: Type.Object(
        {
          runId: Type.String(),
          toolCallId: Type.String(),
          name: Type.String(),
          phase: Type.Union([Type.Literal('start'), Type.Literal('end')]),
          isError: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    },
    strict,
  ),
]);
export type PublicEphemeral = Static<typeof PublicEphemeralSchema>;
