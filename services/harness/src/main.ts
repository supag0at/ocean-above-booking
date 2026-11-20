// harness process entry: a stateless BullMQ worker on queue `harness-wake` (A-01 §7.3, A-02 §3.1).
// Secrets come only from files (D-28): redis password, DeepSeek key, harness service token. No DB credentials.
import { randomBytes } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { createHttpClient } from '@fb/platform/http';
import { createLogger } from '@fb/platform/log';
import { createRedis } from '@fb/platform/redis';
import { FileSecretProvider } from '@fb/platform/secrets';
import type { WakeJob } from '@fb/contracts/server';
import { HttpHands, HttpSessionApi, RedisEphemeralPublisher } from './http.ts';
import { LeaseStore } from './lease.ts';
import { createLlm } from './llm/runtime.ts';
import { onJob } from './runner.ts';

export const WAKE_QUEUE = 'harness-wake';

// Non-secret configuration. (Read by hand: typebox, which @fb/platform/config needs for its schema, is not a harness
// dependency, CONTRACT M-24 ①.)
function readConfig(env: NodeJS.ProcessEnv = process.env): Record<string, string | number> & {
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_USER: string;
  SESSION_API_URL: string;
  HANDS_URL: string;
  SECRETS_DIR: string;
  HARNESS_CONCURRENCY: number;
  LOG_LEVEL: string;
  /** unset: createLlm keeps the DeepSeek catalog base URL */
  LLM_BASE_URL?: string;
} {
  const int = (k: string, d: number): number => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`invalid configuration: ${k} must be a positive integer`);
    return n;
  };
  const str = (k: string, d: string): string => (env[k] === undefined || env[k] === '' ? d : (env[k] as string));
  // empty means unset: do not override the catalog URL (https://api.deepseek.com)
  const llmBase = env.LLM_BASE_URL;
  return {
    REDIS_HOST: str('REDIS_HOST', 'redis'),
    REDIS_PORT: int('REDIS_PORT', 6379),
    REDIS_USER: str('REDIS_USER', 'harness'),
    SESSION_API_URL: str('SESSION_API_URL', 'http://172.30.2.20:8081'),
    HANDS_URL: str('HANDS_URL', 'http://172.30.2.30:8082'),
    SECRETS_DIR: str('SECRETS_DIR', '/run/secrets'),
    HARNESS_CONCURRENCY: int('HARNESS_CONCURRENCY', 4),
    LOG_LEVEL: str('LOG_LEVEL', 'info'),
    ...(typeof llmBase === 'string' && llmBase !== '' ? { LLM_BASE_URL: llmBase } : {}),
  };
}

export async function main(): Promise<void> {
  const cfg = readConfig();
  const secrets = new FileSecretProvider({
    dir: cfg.SECRETS_DIR,
    files: { redis_password: 'redis_harness_password' },
    preload: ['redis_password', 'deepseek_api_key', 'harness_service_token'],
  });
  const log = createLogger({ service: 'harness', level: cfg.LOG_LEVEL, secretValues: () => secrets.values() });
  const workerId = `h${randomBytes(6).toString('hex')}`;
  const redisOpts = { host: cfg.REDIS_HOST, port: cfg.REDIS_PORT, username: cfg.REDIS_USER, secrets } as const;
  const redis = createRedis({ ...redisOpts, connectionName: `harness-${workerId}` });
  // BZPOPMIN blocks longer than the 2 s command timeout. `null` omits it; `0` times out immediately.
  const bullConn = createRedis({
    ...redisOpts,
    maxRetriesPerRequest: null,
    commandTimeoutMs: null,
    connectionName: `harness-bull-${workerId}`,
  });
  const session = new HttpSessionApi(
    createHttpClient({ baseUrl: cfg.SESSION_API_URL }),
    secrets.get('harness_service_token'),
  );
  const hands = new HttpHands(createHttpClient({ baseUrl: cfg.HANDS_URL }));
  // the key is handed to pi through getApiKey only; it never enters a log line or the LLM context.
  // LLM_BASE_URL is optional: unset keeps the DeepSeek catalog address; integration points it at a local stand-in.
  const llm = createLlm({
    apiKey: () => secrets.get('deepseek_api_key'),
    ...(cfg.LLM_BASE_URL !== undefined ? { baseUrl: cfg.LLM_BASE_URL } : {}),
  });
  const deps = {
    session,
    hands,
    publisher: new RedisEphemeralPublisher(redis),
    leases: new LeaseStore(redis, workerId),
    llm,
    log: (msg: string, fields?: Record<string, unknown>) => log.info(fields ?? {}, msg),
  };

  const worker = new Worker<WakeJob>(
    WAKE_QUEUE,
    async (job: Job<WakeJob>) => {
      const outcome = await onJob(deps, job.data.sessionId, job.id ?? 'job');
      log.info({ sessionId: job.data.sessionId, jobId: job.id, outcome }, 'harness.job');
      return outcome; // lease_lost / not_acquired also end the job successfully (§3.2: no retry)
    },
    { connection: bullConn, concurrency: cfg.HARNESS_CONCURRENCY },
  );
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err: err.message }, 'harness.job failed'));
  const stop = async (): Promise<void> => {
    await worker.close();
    redis.disconnect();
    bullConn.disconnect();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  log.info({ workerId }, 'harness worker started');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('main.ts')) {
  void main();
}
