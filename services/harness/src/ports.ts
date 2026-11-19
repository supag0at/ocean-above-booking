// Ports the harness talks to (A-01 §5.1 session API, §5.5 hands, §7.1 pubsub). Implementations: http.ts (real),
// test/fakes (W3 stand-ins). The harness holds no DB credentials and cannot reach booking.
import type { EmitEventRequest, EphemeralEnvelope, GetSessionResponse } from '@fb/contracts/server';
import type { ExecuteRequest, ExecuteResponse } from '@fb/contracts/tools';
import type { Ev } from './events.ts';

export type EmitResult =
  | { readonly status: 'created'; readonly seq: number; readonly retried: boolean }
  | { readonly status: 'deduplicated'; readonly seq: number; readonly retried: boolean }
  /** 409 IDEMPOTENCY_CONFLICT */
  | { readonly status: 'conflict'; readonly retried: boolean }
  /** 409 FENCE_STALE */
  | { readonly status: 'stale' };

export type HandsTokenResult = { readonly status: 'ok'; readonly token: string } | { readonly status: 'stale' | 'inactive' };

export interface SessionApi {
  getSession(sessionId: string): Promise<GetSessionResponse>;
  /** One page, seq ascending. */
  getEvents(sessionId: string, afterSeq: number, limit?: number): Promise<{ events: Ev[]; hasMore: boolean }>;
  emit(sessionId: string, fence: number, req: EmitEventRequest): Promise<EmitResult>;
  handsToken(sessionId: string, fence: number): Promise<HandsTokenResult>;
}

export type HandsResult =
  | { readonly status: 'ok'; readonly response: ExecuteResponse }
  /** 401: token invalid */
  | { readonly status: 'auth' }
  /** 5xx / network after the caller's retries */
  | { readonly status: 'unavailable' };

export interface Hands {
  /** One attempt (retries live in the harness, A-02 §5.1). */
  execute(token: string, req: ExecuteRequest, signal?: AbortSignal): Promise<HandsResult>;
}

/** Ephemeral events -> Redis channel sse:session:{sid} as {kind:'eph', event, fence} (A-01 §7.1). */
export interface EphemeralPublisher {
  publish(event: EphemeralEnvelope): Promise<void>;
}

/** Read the whole log (paged). */
export async function readAll(api: SessionApi, sessionId: string, afterSeq = 0): Promise<Ev[]> {
  const out: Ev[] = [];
  let after = afterSeq;
  for (;;) {
    const page = await api.getEvents(sessionId, after, 500);
    out.push(...page.events);
    const last = page.events[page.events.length - 1];
    if (!page.hasMore || last === undefined) return out;
    after = last.seq;
  }
}
