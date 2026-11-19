// Deterministic keys: wake-job ids (M-7, A-01 §7.3), idempotency keys and messageKeys (M-6, A-02 §3.7),
// trace helper (M-9). Pure string builders, no IO.

export const SWEEP_PERIOD_MS = 15_000;

// ---- doorbell jobIds (M-7). '-' not ':' because BullMQ custom ids may not allow ':' (A-01 §7.3 X-5) ----
export const wakeJobId = (sessionId: string, seq: number): string => `wake-${sessionId}-${assertSeq(seq)}`;
export const sweeperWakeJobId = (sessionId: string, epochMs: number): string =>
  `wake-${sessionId}-scan-${Math.floor(epochMs / SWEEP_PERIOD_MS)}`;

function assertSeq(seq: number): number {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError(`seq must be a positive integer, got ${seq}`);
  return seq;
}

// ---- messageKey (A-02 §3.7) ----
export const assistantMessageKey = (runId: string, attempt: number, n: number): string => `m:${runId}:${attempt}:${n}`;
export const systemMessageKey = assistantMessageKey;
// TODO(T01-REVIEW): CONTRACT M-6 says "toolResult messageKey is `msg:tr:{runId}:{toolCallId}`", but A-02 §3.7 says
// messageKey = `tr:{runId}:{toolCallId}` and `msg:tr:...` is the *idempotencyKey* (= `msg:` + messageKey). Using
// A-02 §3.7 (otherwise the idempotencyKey would become `msg:msg:tr:...`). M-6 looks like a conflation; confirm.
export const toolResultMessageKey = (runId: string, toolCallId: string): string => `tr:${runId}:${toolCallId}`;
export const templateMessageKey = (runId: string, templateId: string): string => `tpl:${runId}:${templateId}`;

// ---- idempotencyKey per event type (A-02 §3.7, A-01 §6.3, M-6) ----
export const userMessageIdempotencyKey = (clientMessageId: string): string => `user:${clientMessageId}`;
export const runStartedIdempotencyKey = (runId: string): string => `run:${runId}:started`;
export const runResumedIdempotencyKey = (runId: string, attempt: number): string => `run:${runId}:resumed:${attempt}`;
/** agent.message (assistant / system / template / toolResult): `msg:{messageKey}`. */
export const messageIdempotencyKey = (messageKey: string): string => `msg:${messageKey}`;
/** = msg:tr:{runId}:{toolCallId} */
export const toolResultIdempotencyKey = (runId: string, toolCallId: string): string =>
  messageIdempotencyKey(toolResultMessageKey(runId, toolCallId));
/** M-6: `offer:{runId}:{toolCallId}` (A-01 §6.3's `offer:{toolCallId}` is superseded). */
export const offerIdempotencyKey = (runId: string, toolCallId: string): string => `offer:${runId}:${toolCallId}`;
export const guardViolationIdempotencyKey = (runId: string, n: number): string => `guard:${runId}:${n}`;
/** Shared by run_completed and run_failed so a run has exactly one ending. */
export const runDoneIdempotencyKey = (runId: string): string => `run:${runId}:done`;
export const compactionId = (boundaryRunId: string): string => `cmp_${boundaryRunId}`;
export const compactIdempotencyKey = (cmpId: string): string => `compact:${cmpId}`;
export const bookingConfirmedIdempotencyKey = (quoteId: string): string => `booking:${quoteId}`;
export const bookingFailedIdempotencyKey = (quoteId: string, traceId: string): string =>
  `booking-failed:${quoteId}:${traceId}`;

/** hands idempotency key tuple (M-6): (session_id, run_id, tool_call_id). */
export const handsIdempotencyTuple = (
  sessionId: string,
  runId: string,
  toolCallId: string,
): readonly [string, string, string] => [sessionId, runId, toolCallId] as const;

// ---- trace headers (M-9): X-Trace-Id = trace-id part of traceparent ----
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
export function traceIdFromTraceparent(traceparent: string): string | null {
  const m = TRACEPARENT.exec(traceparent);
  if (!m || m[1] === '0'.repeat(32)) return null;
  return m[1] ?? null;
}
