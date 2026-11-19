// @fb/platform/fastify: the one place that constructs Fastify (A-01 §2.2, §4.1, §8, H-08, CONTRACT CT-07).
// - ajv options are fixed here and cannot be overridden by services (D-24);
// - listening address is a concrete interface address, wildcard binds are refused (fail closed);
// - every request passes a peer-address check against socket.remoteAddress (never forwarded headers);
// - trace middleware: traceparent in, X-Trace-Id out; unified error envelope.
import { BlockList, isIP } from 'node:net';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ERROR_HTTP_STATUS, type HttpErrorCode as ErrorCode } from '@fb/contracts/web';
import { TRACE_ID_HEADER, resolveIncomingTrace } from '../trace/index.ts';

export type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// ---- ajv (CT-07 / A-01 §4.1): never coerce, never strip, never default ----
export const AJV_CUSTOM_OPTIONS = Object.freeze({
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  allErrors: false,
}) satisfies Record<string, boolean>;

// ---- error envelope (A-01 §4.1) ----
// TODO(T02): switch to contracts ApiError type if @fb/contracts/server exports one for the web entry too.
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; traceId: string };
}

export function errorEnvelope(code: ErrorCode, message: string, traceId: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}), traceId } };
}

/** Throw from a handler to produce a contract error: status comes from the ErrorCode table (A-01 §4.6). */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.details = details;
  }
  get statusCode(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

// ---- peers (A-01 §2.2) ----
export function parseCidrList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const raw of cidrs) {
    const [addr, prefix] = raw.trim().split('/');
    const family = addr === undefined ? 0 : isIP(addr);
    if (addr === undefined || family === 0) throw new Error(`invalid allowed peer "${raw}"`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    const max = family === 4 ? 32 : 128;
    const bits = prefix === undefined ? max : Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`invalid allowed peer "${raw}"`);
    list.addSubnet(addr, bits, type);
  }
  return list;
}

/** true when `address` (as in socket.remoteAddress) lies inside one of the CIDRs */
export function cidrContains(cidrs: readonly string[] | BlockList, address: string | undefined): boolean {
  if (address === undefined) return false;
  const list = Array.isArray(cidrs) ? parseCidrList(cidrs) : (cidrs as BlockList);
  const addr = address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  const family = isIP(addr);
  if (family === 0) return false;
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export interface BindAddress {
  readonly host: string;
  readonly port: number;
}

/** "172.30.1.20:8080" or "[::1]:8080". Wildcard hosts are rejected (A-01 §2.2: bind a specific interface). */
export function parseBind(bind: string): BindAddress {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(bind.trim());
  const host = m?.[1] ?? m?.[2];
  const port = m ? Number(m[3]) : NaN;
  if (host === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid bind address "${bind}" (expected host:port)`);
  }
  if (isIP(host) === 0) throw new Error(`bind host must be an IP address, got "${host}"`);
  if (host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0') {
    throw new Error(`refusing to bind wildcard address "${host}": bind a specific interface (A-01 §2.2)`);
  }
  return { host, port };
}

// ---- request trace ----
export interface RequestTrace {
  readonly traceparent: string;
  readonly traceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    trace: RequestTrace;
  }
}

export interface ServerOptions {
  /** "host:port"; used by createServer / listen, not needed for inject-only tests */
  readonly bind?: string;
  /** CIDRs/IPs allowed to connect; every other peer gets 403 FORBIDDEN_PEER */
  readonly allowedPeers: readonly string[];
  /** register routes on the new instance; each port is its own Fastify instance */
  readonly routes?: (app: FastifyInstance) => void | Promise<void>;
  readonly logger?: FastifyBaseLogger;
  /** request body limit in bytes; default 16 KB (A-01 §4.1) */
  readonly bodyLimit?: number;
  /** trust X-Forwarded-For from allowedPeers (public port only), for req.ip in logs. Never used for the peer check. */
  readonly trustProxy?: boolean;
  /** /readyz probe: throw to report not ready (503 SERVICE_UNAVAILABLE) */
  readonly ready?: () => void | Promise<void>;
}

function envelopeFor(req: FastifyRequest): string {
  return req.trace?.traceId ?? '0'.repeat(32);
}

function statusToCode(status: number): ErrorCode {
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status >= 500) return 'INTERNAL';
  // TODO(T02-REVIEW): A-01 §4.6 has no code for 404 (unknown route), 405 or 415 (wrong content type) or
  // malformed JSON. They are reported as VALIDATION_FAILED with their real HTTP status; confirm or add codes.
  return 'VALIDATION_FAILED';
}

interface FastifyLikeError extends Error {
  statusCode?: number;
  validation?: { instancePath?: string; keyword?: string; message?: string; params?: unknown }[];
  validationContext?: string;
}

function sendError(req: FastifyRequest, reply: FastifyReply, err: FastifyLikeError): FastifyReply {
  const traceId = envelopeFor(req);
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send(errorEnvelope(err.code, err.message, traceId, err.details));
  }
  if (err.validation) {
    const details = err.validation.map((v) => ({
      in: err.validationContext,
      path: v.instancePath ?? '',
      keyword: v.keyword,
      message: v.message,
      ...(v.keyword === 'additionalProperties' && typeof v.params === 'object' && v.params !== null
        ? { property: (v.params as { additionalProperty?: unknown }).additionalProperty }
        : {}),
    }));
    return reply.code(400).send(errorEnvelope('VALIDATION_FAILED', 'request validation failed', traceId, details));
  }
  const status = err.statusCode !== undefined && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error({ err, traceId }, 'unhandled error');
    return reply.code(500).send(errorEnvelope('INTERNAL', 'internal error', traceId));
  }
  return reply.code(status).send(errorEnvelope(statusToCode(status), err.message, traceId));
}

/** Builds (does not listen) one Fastify instance with all platform guarantees applied. */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const peers = parseCidrList(options.allowedPeers);
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? 16 * 1024,
    ...(options.logger !== undefined ? { loggerInstance: options.logger } : { logger: false }),
    // CT-07: fixed, not overridable through ServerOptions
    ajv: { customOptions: { ...AJV_CUSTOM_OPTIONS } },
    // trust only the allowed peers, and only when asked to (public port)
    trustProxy: options.trustProxy === true ? [...options.allowedPeers] : false,
  });

  app.decorateRequest('trace', null as unknown as RequestTrace);

  // 1) trace, 2) peer check. Trace first so even FORBIDDEN_PEER carries a traceId.
  app.addHook('onRequest', async (req, reply) => {
    const t = resolveIncomingTrace(req.headers);
    req.trace = { traceparent: t.traceparent, traceId: t.traceId };
    if (t.mismatch) req.log.warn({ traceId: t.traceId }, 'X-Trace-Id disagrees with traceparent; using traceparent');
    void reply.header(TRACE_ID_HEADER, t.traceId);

    // always socket.remoteAddress, never X-Forwarded-For
    if (!cidrContains(peers, req.raw.socket.remoteAddress)) {
      req.log.warn({ peer: req.raw.socket.remoteAddress }, 'peer not allowed');
      return reply.code(403).send(errorEnvelope('FORBIDDEN_PEER', 'peer address not allowed', t.traceId));
    }
    return undefined;
  });

  app.setErrorHandler((err, req, reply) => sendError(req, reply, err as FastifyLikeError));
  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send(
        errorEnvelope('VALIDATION_FAILED', `route ${req.method} ${req.url.split('?')[0]} not found`, envelopeFor(req)),
      ),
  );

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (req, reply) => {
    try {
      await options.ready?.();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send(errorEnvelope('SERVICE_UNAVAILABLE', 'dependency not ready', envelopeFor(req)));
    }
  });

  if (options.routes) await options.routes(app);
  await app.ready();
  return app;
}

/** buildServer + listen on the fixed interface address. A missing address makes listen reject (fail closed). */
export async function createServer(options: ServerOptions & { readonly bind: string }): Promise<FastifyInstance> {
  const { host, port } = parseBind(options.bind);
  const app = await buildServer(options);
  await app.listen({ host, port });
  return app;
}
