// Login sessions, cookies and CSRF (A-01 §4.2, I-8, D-08, D-23, S-4).
// - fb_sid: 32 random bytes, HttpOnly; SameSite=Strict; Path=/ (+ Secure once there is TLS);
// - fb_csrf: 32 random bytes, readable by the SPA (double submit);
// - Redis auth:sess:{k} -> { userId, csrf, createdAt }, TTL 7 days, renewed on every request.
//   k = HMAC-SHA256(cookie_secret, sid): Redis never holds a usable cookie value.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, type FastifyReply, type FastifyRequest } from '@fb/platform/fastify';
import type { Redis } from '@fb/platform/redis';

export const SID_COOKIE = 'fb_sid';
export const CSRF_COOKIE = 'fb_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const AUTH_TTL_SECONDS = 7 * 24 * 3600;

export interface AuthContext {
  /** opaque per-login key (HMAC of the cookie), used for the SSE logout fan-out */
  readonly key: string;
  readonly userId: string;
  readonly csrf: string;
}

// per-request auth result (fastify module augmentation is unavailable: 'fastify' resolves only inside platform)
const AUTH = new WeakMap<FastifyRequest, AuthContext>();
export const authOfRequest = (req: FastifyRequest): AuthContext | undefined => AUTH.get(req);

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class AuthStore {
  private readonly redis: Redis;
  private readonly cookieSecret: string;
  constructor(redis: Redis, cookieSecret: string) {
    this.redis = redis;
    this.cookieSecret = cookieSecret;
  }

  keyOf(sid: string): string {
    return createHmac('sha256', this.cookieSecret).update(sid).digest('hex');
  }
  private redisKey(key: string): string {
    return `auth:sess:${key}`;
  }

  async create(userId: string): Promise<{ sid: string; csrf: string; key: string }> {
    const sid = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const key = this.keyOf(sid);
    await this.redis
      .multi()
      .hset(this.redisKey(key), { userId, csrf, createdAt: new Date().toISOString() })
      .expire(this.redisKey(key), AUTH_TTL_SECONDS)
      .exec();
    return { sid, csrf, key };
  }

  /** Resolve and renew (sliding TTL). Null when the cookie is absent or the session expired / was deleted. */
  async resolve(sid: string | undefined): Promise<AuthContext | null> {
    if (!sid || !/^[A-Za-z0-9_-]{20,100}$/.test(sid)) return null;
    const key = this.keyOf(sid);
    const h = await this.redis.hgetall(this.redisKey(key));
    if (!h.userId || !h.csrf) return null;
    await this.redis.expire(this.redisKey(key), AUTH_TTL_SECONDS);
    return { key, userId: h.userId, csrf: h.csrf };
  }

  async destroy(key: string): Promise<void> {
    await this.redis.del(this.redisKey(key));
  }
}

export interface CookieOptions {
  readonly secure: boolean;
}

export function setAuthCookies(reply: FastifyReply, sid: string, csrf: string, o: CookieOptions): void {
  const tail = `Path=/; Max-Age=${AUTH_TTL_SECONDS}; SameSite=Strict${o.secure ? '; Secure' : ''}`;
  void reply.header('set-cookie', [`${SID_COOKIE}=${sid}; HttpOnly; ${tail}`, `${CSRF_COOKIE}=${csrf}; ${tail}`]);
}

export function clearAuthCookies(reply: FastifyReply, o: CookieOptions): void {
  const tail = `Path=/; Max-Age=0; SameSite=Strict${o.secure ? '; Secure' : ''}`;
  void reply.header('set-cookie', [`${SID_COOKIE}=; HttpOnly; ${tail}`, `${CSRF_COOKIE}=; ${tail}`]);
}

export const sidFrom = (req: FastifyRequest): string | undefined => parseCookies(req.headers.cookie).get(SID_COOKIE);

/** Which CSRF row of the A-01 §4.2 table a route belongs to. */
export type WriteKind = 'login' | 'json' | 'bodyless';

const hasBody = (req: FastifyRequest): boolean => {
  const len = req.headers['content-length'];
  if (len !== undefined && len !== '0') return true;
  return req.headers['transfer-encoding'] !== undefined;
};

/**
 * Non-GET checks (A-01 §4.2). Runs in onRequest, i.e. before the body is parsed, so a wrong Content-Type is a
 * 403 CSRF_INVALID and not Fastify's 415. Order: Origin -> session (401) -> CSRF token -> Content-Type / body.
 */
export function writeGuard(
  kind: WriteKind,
  publicOrigin: string,
  store: AuthStore,
): (req: FastifyRequest) => Promise<void> {
  return async (req) => {
    if (req.headers.origin !== publicOrigin) throw new HttpError('CSRF_INVALID', 'origin check failed');
    if (kind !== 'login') {
      const auth = await redisOr503(() => store.resolve(sidFrom(req)));
      if (!auth) throw new HttpError('AUTH_REQUIRED', 'login required');
      AUTH.set(req, auth);
      const token = req.headers[CSRF_HEADER];
      if (typeof token !== 'string' || !safeEqual(token, auth.csrf)) {
        throw new HttpError('CSRF_INVALID', 'csrf token check failed');
      }
    }
    if (kind === 'bodyless') {
      // the SPA sends neither a body nor a Content-Type on these (avoids FST_ERR_CTP_EMPTY_JSON_BODY)
      if (hasBody(req)) throw new HttpError('VALIDATION_FAILED', 'this endpoint takes no request body');
    } else {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (ct !== 'application/json') throw new HttpError('CSRF_INVALID', 'content-type must be application/json');
    }
  };
}

/** GET guard: session required. */
export function readGuard(store: AuthStore): (req: FastifyRequest) => Promise<void> {
  return async (req) => {
    const auth = await redisOr503(() => store.resolve(sidFrom(req)));
    if (!auth) throw new HttpError('AUTH_REQUIRED', 'login required');
    AUTH.set(req, auth);
  };
}

/** Redis failures on the request path are 503 SERVICE_UNAVAILABLE (A-01 §4.6, §11). */
export async function redisOr503<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError('SERVICE_UNAVAILABLE', 'session store unavailable');
  }
}
