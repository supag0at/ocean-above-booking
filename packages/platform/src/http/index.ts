// @fb/platform/http: service-to-service HTTP client on undici (A-01 §2.5, §8, §11; CONTRACT M-9).
// - always sends `traceparent` and `X-Trace-Id` (callers must not build them themselves);
// - every attempt has a timeout;
// - only idempotent requests are retried.
//
// TODO(T02-REVIEW): A-01 §11 gives no explicit HTTP-client retry table (it only says booking timeouts
// are safe to retry, §4.6/§5.4, and writes carry idempotency keys, §7). Rules implemented here:
//   * retried: GET/HEAD/OPTIONS/PUT/DELETE, or any request with `idempotent: true` (e.g. POSTs that carry an
//     idempotency key); NEVER a bare POST/PATCH;
//   * retried on: network error, timeout, and HTTP 502/503/504; at most `retries` (default 2) extra attempts,
//     exponential backoff 100 ms * 2^n with jitter; 4xx and 500 are never retried;
//   * default timeout 5 s per attempt (A-01 §2.5 table: gateway<->harness/booking).
// Confirm the numbers and whether a total deadline across attempts is wanted.
import { Agent, request, type Dispatcher } from 'undici';
import {
  TRACEPARENT_HEADER,
  TRACE_ID_HEADER,
  childTraceparent,
  generateTraceparent,
  traceIdFromTraceparent,
} from '../trace/index.ts';

export class HttpClientError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpClientError';
    this.attempts = attempts;
  }
}
export class HttpTimeoutError extends HttpClientError {
  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super(message, attempts, options);
    this.name = 'HttpTimeoutError';
  }
}
export class HttpNetworkError extends HttpClientError {
  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super(message, attempts, options);
    this.name = 'HttpNetworkError';
  }
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  /** parses `text` as JSON (throws SyntaxError on invalid JSON) */
  json<T = unknown>(): T;
  /** how many attempts were made (1 = no retry) */
  readonly attempts: number;
}

export interface HttpRequestOptions {
  readonly method?: string;
  /** path (and optional query string) appended to baseUrl, or an absolute URL when no baseUrl is set */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** serialized with JSON.stringify; sets content-type application/json */
  readonly json?: unknown;
  readonly body?: string | Uint8Array;
  readonly timeoutMs?: number;
  /** mark a non-idempotent method (POST) as safe to retry because it carries an idempotency key */
  readonly idempotent?: boolean;
  /** override the client default; 0 disables retry */
  readonly retries?: number;
  /** traceparent of the caller's current span; a new trace is started when absent */
  readonly traceparent?: string;
}

export interface HttpClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
  /** headers sent on every request (e.g. Authorization); trace headers always win */
  readonly headers?: Readonly<Record<string, string>>;
  /** supplies the current traceparent when a request does not set one (e.g. from request-scoped context) */
  readonly currentTraceparent?: () => string | undefined;
  /** undici dispatcher (tests pass a MockAgent; EGRESS_PROXY_URL users pass a ProxyAgent) */
  readonly dispatcher?: Dispatcher;
}

export interface HttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
  get(path: string, options?: Omit<HttpRequestOptions, 'path' | 'method' | 'json' | 'body'>): Promise<HttpResponse>;
  post(
    path: string,
    json: unknown,
    options?: Omit<HttpRequestOptions, 'path' | 'method' | 'json'>,
  ): Promise<HttpResponse>;
  close(): Promise<void>;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRY_STATUS = new Set([502, 503, 504]);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']);

function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return err.name === 'TimeoutError' || (typeof code === 'string' && TIMEOUT_CODES.has(code));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const ownAgent = options.dispatcher === undefined;
  const dispatcher: Dispatcher = options.dispatcher ?? new Agent();
  const defaultTimeout = options.timeoutMs ?? 5000;
  const defaultRetries = options.retries ?? 2;
  const baseDelay = options.retryBaseDelayMs ?? 100;

  async function once(
    url: string,
    o: HttpRequestOptions,
    method: string,
    timeoutMs: number,
  ): Promise<Omit<HttpResponse, 'attempts'>> {
    const parent = o.traceparent ?? options.currentTraceparent?.();
    const traceparent = parent ? childTraceparent(parent) : generateTraceparent();
    const traceId = traceIdFromTraceparent(traceparent) ?? '';
    const headers: Record<string, string> = { ...options.headers, ...o.headers };
    // M-9: both headers, set last so no caller can override them (also removes any case variants)
    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      if (lower === TRACEPARENT_HEADER || lower === TRACE_ID_HEADER) delete headers[k];
    }
    headers[TRACEPARENT_HEADER] = traceparent;
    headers['X-Trace-Id'] = traceId;
    let body: string | Uint8Array | undefined = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
    const res = await request(url, {
      method: method as Dispatcher.HttpMethod,
      headers,
      ...(body !== undefined ? { body } : {}),
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.body.text();
    return {
      status: res.statusCode,
      headers: res.headers,
      text,
      json: <T = unknown>(): T => JSON.parse(text) as T,
    };
  }

  async function doRequest(o: HttpRequestOptions): Promise<HttpResponse> {
    const method = (o.method ?? 'GET').toUpperCase();
    const url = options.baseUrl !== undefined ? new URL(o.path, options.baseUrl).toString() : o.path;
    const timeoutMs = o.timeoutMs ?? defaultTimeout;
    const canRetry = o.idempotent === true || IDEMPOTENT_METHODS.has(method);
    const maxRetries = canRetry ? (o.retries ?? defaultRetries) : 0;

    for (let attempt = 1; ; attempt++) {
      const last = attempt > maxRetries;
      try {
        const res = await once(url, o, method, timeoutMs);
        if (!last && RETRY_STATUS.has(res.status)) {
          await sleep(baseDelay * 2 ** (attempt - 1) * (0.5 + Math.random()));
          continue;
        }
        return { ...res, attempts: attempt };
      } catch (cause) {
        if (!last) {
          await sleep(baseDelay * 2 ** (attempt - 1) * (0.5 + Math.random()));
          continue;
        }
        if (isTimeout(cause)) {
          throw new HttpTimeoutError(`${method} ${url} timed out after ${timeoutMs} ms (attempt ${attempt})`, attempt, {
            cause,
          });
        }
        throw new HttpNetworkError(
          `${method} ${url} failed: ${(cause as Error).message} (attempt ${attempt})`,
          attempt,
          { cause },
        );
      }
    }
  }

  return {
    request: doRequest,
    get: (path, o) => doRequest({ ...o, path, method: 'GET' }),
    post: (path, json, o) => doRequest({ ...o, path, method: 'POST', json }),
    async close(): Promise<void> {
      if (ownAgent) await dispatcher.close();
    },
  };
}
