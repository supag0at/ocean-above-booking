// @fb/platform/trace: Tracer / Span interfaces, a no-op implementation and traceparent helpers
// (A-01 §8, CONTRACT-v1 M-9). Real OTel wiring is future work; only the interfaces and the
// traceparent propagation are guaranteed here. No third-party import is needed for that.
import { randomBytes } from 'node:crypto';

// TODO(T02): switch to contracts (@fb/contracts/server HEADER) once its shape is stable.
export const TRACEPARENT_HEADER = 'traceparent';
export const TRACE_ID_HEADER = 'x-trace-id';

export interface ParsedTraceparent {
  readonly version: '00';
  readonly traceId: string; // 32 lowercase hex
  readonly spanId: string; // 16 lowercase hex
  readonly flags: string; // 2 hex
  readonly sampled: boolean;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/** Fresh traceparent (new trace, sampled flag set). */
export function generateTraceparent(): string {
  return formatTraceparent(newTraceId(), newSpanId());
}

/** Returns null for anything that is not a valid version-00 traceparent (all-zero ids are invalid). */
export function parseTraceparent(value: string | undefined | null): ParsedTraceparent | null {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  const [, traceId, spanId, flags] = m;
  if (traceId === undefined || spanId === undefined || flags === undefined) return null;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { version: '00', traceId, spanId, flags, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function traceIdFromTraceparent(value: string | undefined | null): string | null {
  return parseTraceparent(value)?.traceId ?? null;
}

/** Same trace, new span id: the traceparent to send on an outgoing call. */
export function childTraceparent(parent: string): string {
  const p = parseTraceparent(parent);
  if (!p) return generateTraceparent();
  return formatTraceparent(p.traceId, newSpanId(), p.flags);
}

export interface ResolvedTrace {
  readonly traceparent: string;
  readonly traceId: string;
  /** true when X-Trace-Id was present but disagreed with traceparent (traceparent wins, caller logs a warn) */
  readonly mismatch: boolean;
}

/**
 * Incoming-request rule (A-01 §8): traceparent wins; X-Trace-Id alone is not trusted to build one
 * (it cannot carry a span id), so a missing or invalid traceparent produces a fresh trace.
 */
export function resolveIncomingTrace(headers: {
  readonly [name: string]: string | string[] | undefined;
}): ResolvedTrace {
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const raw = one(headers[TRACEPARENT_HEADER]);
  const tp = parseTraceparent(raw);
  const xid = one(headers[TRACE_ID_HEADER]);
  if (tp && raw !== undefined) {
    return {
      traceparent: raw.trim(),
      traceId: tp.traceId,
      mismatch: xid !== undefined && xid.trim().toLowerCase() !== tp.traceId,
    };
  }
  const fresh = generateTraceparent();
  return { traceparent: fresh, traceId: fresh.slice(3, 35), mismatch: false };
}

export type SpanAttributeValue = string | number | boolean;

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  /** W3C traceparent that identifies this span (use it for outgoing calls) */
  readonly traceparent: string;
  setAttribute(key: string, value: SpanAttributeValue): this;
  recordException(error: unknown): this;
  end(): void;
}

export interface StartSpanOptions {
  /** traceparent of the parent; when absent a new trace starts */
  readonly parent?: string;
  readonly attributes?: Readonly<Record<string, SpanAttributeValue>>;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
}

class NoopSpan implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceparent: string;
  constructor(parent: string | undefined) {
    const p = parseTraceparent(parent);
    this.traceId = p?.traceId ?? newTraceId();
    this.spanId = newSpanId();
    this.traceparent = formatTraceparent(this.traceId, this.spanId, p?.flags ?? '01');
  }
  setAttribute(): this {
    return this;
  }
  recordException(): this {
    return this;
  }
  end(): void {}
}

/** Default tracer: records nothing but still produces correct ids, so traceparent propagation works. */
export const noopTracer: Tracer = {
  startSpan: (_name, options) => new NoopSpan(options?.parent),
};
