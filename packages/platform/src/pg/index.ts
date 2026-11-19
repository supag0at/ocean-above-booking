// @fb/platform/pg: pg pool factory (A-01 §2.3, §2.5). The password comes from SecretProvider; there is
// no DATABASE_URL. Statement timeout defaults to 5 s (A-01 §2.5).
import { Pool, type PoolConfig } from 'pg';
import type { SecretProvider } from '../secrets/index.ts';

export type { Pool } from 'pg';

export interface CreatePgPoolOptions {
  readonly host: string;
  readonly port?: number;
  readonly database: string;
  readonly user: string;
  readonly secrets: SecretProvider;
  /** which logical secret holds this service's password; default pg_password */
  readonly passwordSecret?: 'pg_password';
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly applicationName?: string;
  /** called for errors on idle clients (otherwise they would crash the process) */
  readonly onError?: (err: Error) => void;
}

export function createPgPool(options: CreatePgPoolOptions): Pool {
  const statementTimeout = options.statementTimeoutMs ?? 5000;
  const config: PoolConfig = {
    host: options.host,
    port: options.port ?? 5432,
    database: options.database,
    user: options.user,
    password: options.secrets.get(options.passwordSecret ?? 'pg_password'),
    max: options.max ?? 10,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 1000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 2000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    ...(options.applicationName !== undefined ? { application_name: options.applicationName } : {}),
  };
  const pool = new Pool(config);
  pool.on('error', (err) => options.onError?.(err));
  return pool;
}
