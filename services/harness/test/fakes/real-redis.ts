// Connection to the REAL redis:7 used by the lease / recovery tests (docker; T09_REDIS_URL, default
// redis://default:t09-local-test@127.0.0.1:6390). Returns undefined when nothing is listening, so callers can skip.
//   docker run -d --rm --name t09-redis -p 127.0.0.1:6390:6379 redis:7 redis-server --requirepass t09-local-test
import { createRedis, type Redis } from '@fb/platform/redis';

export const REAL_REDIS_URL = new URL(process.env.T09_REDIS_URL ?? 'redis://default:t09-local-test@127.0.0.1:6390');

export async function connectRealRedis(): Promise<Redis | undefined> {
  const url = REAL_REDIS_URL;
  const r = createRedis({
    host: url.hostname,
    port: Number(url.port),
    username: decodeURIComponent(url.username) || 'default',
    secrets: { get: () => decodeURIComponent(url.password) },
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeoutMs: 500,
  });
  try {
    await r.connect();
    await r.ping();
    return r;
  } catch {
    r.disconnect();
    return undefined;
  }
}
