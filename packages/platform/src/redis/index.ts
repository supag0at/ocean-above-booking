// @fb/platform/redis: ioredis factory (A-01 §2.3, §2.5). ACL username from config, password from SecretProvider.
import { Redis, type RedisOptions } from 'ioredis';
import type { SecretProvider } from '../secrets/index.ts';

export type { Redis } from 'ioredis';

export interface CreateRedisOptions {
  readonly host: string;
  readonly port?: number;
  /** ACL user (e.g. gateway / harness) */
  readonly username: string;
  readonly secrets: SecretProvider;
  /** logical secret holding the ACL password; default redis_password */
  readonly passwordSecret?: 'redis_password';
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** BullMQ workers need `null`; default is ioredis' own default (20) */
  readonly maxRetriesPerRequest?: number | null;
  readonly lazyConnect?: boolean;
  readonly connectionName?: string;
}

export function createRedis(options: CreateRedisOptions): Redis {
  const config = {
    host: options.host,
    port: options.port ?? 6379,
    username: options.username,
    password: options.secrets.get(options.passwordSecret ?? 'redis_password'),
    // A-01 §2.5: Redis calls time out after 2 s
    connectTimeout: options.connectTimeoutMs ?? 2000,
    commandTimeout: options.commandTimeoutMs ?? 2000,
    lazyConnect: options.lazyConnect ?? false,
    ...(options.maxRetriesPerRequest !== undefined ? { maxRetriesPerRequest: options.maxRetriesPerRequest } : {}),
    ...(options.connectionName !== undefined ? { connectionName: options.connectionName } : {}),
  } satisfies RedisOptions;
  return new Redis(config);
}
