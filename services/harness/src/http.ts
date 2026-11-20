// HTTP implementations of the ports (A-01 §5.1, §5.5) on @fb/platform/http (trace headers added by the client, M-9).
import { HttpClientError, type HttpClient } from '@fb/platform/http';
import type { EmitEventRequest, EphemeralEnvelope, GetSessionResponse } from '@fb/contracts/server';
import type { ExecuteRequest, ExecuteResponse } from '@fb/contracts/tools';
import type { Ev } from './events.ts';
import type { EmitResult, EphemeralPublisher, Hands, HandsResult, HandsTokenResult, SessionApi } from './ports.ts';

function errorCode(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

export class HttpSessionApi implements SessionApi {
  private readonly http: HttpClient;
  private readonly serviceToken: string;
  constructor(http: HttpClient, serviceToken: string) {
    this.http = http;
    this.serviceToken = serviceToken;
  }

  private auth(fence?: number): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceToken}`,
      ...(fence !== undefined ? { 'x-lease-fence': String(fence) } : {}),
    };
  }

  async getSession(sessionId: string): Promise<GetSessionResponse> {
    const r = await this.http.get(`/internal/v1/sessions/${sessionId}`, { headers: this.auth() });
    if (r.status !== 200) throw new Error(`getSession: HTTP ${r.status} ${errorCode(r.text) ?? ''}`);
    return r.json<GetSessionResponse>();
  }

  async getEvents(sessionId: string, afterSeq: number, limit = 500): Promise<{ events: Ev[]; hasMore: boolean }> {
    const r = await this.http.get(`/internal/v1/sessions/${sessionId}/events?afterSeq=${afterSeq}&limit=${limit}`, {
      headers: this.auth(),
    });
    if (r.status !== 200) throw new Error(`getEvents: HTTP ${r.status} ${errorCode(r.text) ?? ''}`);
    return r.json<{ events: Ev[]; hasMore: boolean }>();
  }

  async emit(sessionId: string, fence: number, req: EmitEventRequest): Promise<EmitResult> {
    // carries an idempotency key, so the client may retry it (A-01 §5.1 step 6)
    const r = await this.http.post(`/internal/v1/sessions/${sessionId}/events`, req, {
      headers: this.auth(fence),
      idempotent: true,
    });
    const retried = r.attempts > 1;
    if (r.status === 201) return { status: 'created', seq: r.json<{ seq: number }>().seq, retried };
    if (r.status === 200) return { status: 'deduplicated', seq: r.json<{ seq: number }>().seq, retried };
    const code = errorCode(r.text);
    if (r.status === 409 && code === 'FENCE_STALE') return { status: 'stale' };
    if (r.status === 409 && code === 'IDEMPOTENCY_CONFLICT') return { status: 'conflict', retried };
    throw new Error(`emit ${req.type}: HTTP ${r.status} ${code ?? ''}`);
  }

  async handsToken(sessionId: string, fence: number): Promise<HandsTokenResult> {
    const r = await this.http.post(`/internal/v1/sessions/${sessionId}/hands-token`, {}, { headers: this.auth(fence) });
    if (r.status === 200) return { status: 'ok', token: r.json<{ token: string }>().token };
    const code = errorCode(r.text);
    if (r.status === 409 && code === 'FENCE_STALE') return { status: 'stale' };
    if (r.status === 409 && code === 'SESSION_INACTIVE') return { status: 'inactive' };
    throw new Error(`handsToken: HTTP ${r.status} ${code ?? ''}`);
  }
}

/** CONTRACT M-23 ③: one execute attempt times out after 10s. */
export const HANDS_TIMEOUT_MS = 10_000;

export class HttpHands implements Hands {
  private readonly http: HttpClient;
  constructor(http: HttpClient) {
    this.http = http;
  }

  async execute(token: string, req: ExecuteRequest): Promise<HandsResult> {
    try {
      // retries are done by the harness with the same toolCallId (200ms, 800ms), not by the client
      const r = await this.http.post('/internal/execute', req, {
        headers: { authorization: `Bearer ${token}` },
        retries: 0,
        timeoutMs: HANDS_TIMEOUT_MS,
      });
      if (r.status === 200) return { status: 'ok', response: r.json<ExecuteResponse>() };
      if (r.status === 401) return { status: 'auth' };
      return { status: 'unavailable' };
    } catch (e) {
      if (e instanceof HttpClientError) return { status: 'unavailable' };
      throw e;
    }
  }
}

/** Minimal publish surface (ioredis). */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export class RedisEphemeralPublisher implements EphemeralPublisher {
  private readonly redis: RedisPublisher;
  constructor(redis: RedisPublisher) {
    this.redis = redis;
  }
  async publish(event: EphemeralEnvelope): Promise<void> {
    await this.redis.publish(
      `sse:session:${event.sessionId}`,
      JSON.stringify({ kind: 'eph', event, fence: event.fence }),
    );
  }
}
