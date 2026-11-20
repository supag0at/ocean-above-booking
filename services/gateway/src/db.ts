// Postgres helpers for the gateway (role fb_gateway, A-01 §3.3). The pool comes from @fb/platform/pg.
import type { Pool } from '@fb/platform/pg';
import { HttpError } from '@fb/platform/fastify';

export type { Pool };
/** The subset of pg's PoolClient we use ('pg' itself is not resolvable from gateway, A-01 §1.2). */
export interface PgClient {
  query: Pool['query'];
  release(err?: boolean | Error): void;
}
export type Queryable = Pick<Pool, 'query'>;

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** pg returns bigint as string; all our bigints are < 2^53. */
export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '57P02',
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

/** Connection-level failures become 503 SERVICE_UNAVAILABLE (A-01 §4.6, §11); everything else is rethrown. */
export function mapDbError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  const e = err as { code?: unknown; message?: unknown };
  const msg = typeof e.message === 'string' ? e.message : '';
  if (
    (typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code)) ||
    /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(msg)
  ) {
    throw new HttpError('SERVICE_UNAVAILABLE', 'database unavailable');
  }
  throw err;
}

/** BEGIN … COMMIT on one pooled client; ROLLBACK on any throw. */
export async function tx<T>(pool: Pool, fn: (c: PgClient) => Promise<T>): Promise<T> {
  let client: PgClient;
  try {
    client = await pool.connect();
  } catch (err) {
    return mapDbError(err);
  }
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    return mapDbError(err);
  } finally {
    client.release();
  }
}

/** pool.query with connection errors mapped to 503. */
export async function q<R = Record<string, unknown>>(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  try {
    const r = await db.query(text, values);
    return r.rows as R[];
  } catch (err) {
    return mapDbError(err);
  }
}

export const isUniqueViolation = (err: unknown): boolean => (err as { code?: unknown }).code === '23505';

/** Retry once when the (session, idempotency_key) unique constraint fires (A-01 §5.1 step 7). */
export async function withUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return fn();
  }
}
