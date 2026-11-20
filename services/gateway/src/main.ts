// Process entry point (container CMD: node services/gateway/src/main.ts). Non-secret config from the environment,
// secrets from /run/secrets via FileSecretProvider (D-28). Any missing piece aborts startup (fail closed).
import { createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createHttpClient } from '@fb/platform/http';
import { createLogger } from '@fb/platform/log';
import { createPgPool } from '@fb/platform/pg';
import { createRedis } from '@fb/platform/redis';
import { FileSecretProvider } from '@fb/platform/secrets';
import { buildGateway, type Gateway } from './app.ts';
import { loadGatewayConfig } from './config.ts';

/** service-internal secret name -> mounted file name (A-01 §2.3 matrix, gateway column) */
export const GATEWAY_SECRET_FILES = {
  pg_password: 'pg_gateway_password',
  redis_password: 'redis_gateway_password',
  harness_service_token: 'harness_service_token',
  booking_service_token: 'booking_service_token',
  hands_token_signing_key: 'hands_token_signing_key',
  cookie_secret: 'cookie_secret',
} as const;

export async function startGateway(env: NodeJS.ProcessEnv = process.env): Promise<Gateway> {
  const cfg = loadGatewayConfig(env);
  const secrets = new FileSecretProvider({
    dir: cfg.secretsDir,
    files: GATEWAY_SECRET_FILES,
    preload: Object.keys(GATEWAY_SECRET_FILES) as (keyof typeof GATEWAY_SECRET_FILES)[],
  });
  const log = createLogger({ service: 'gateway', level: cfg.logLevel, secretValues: () => secrets.values() });
  const pool = createPgPool({
    ...cfg.pg,
    secrets,
    applicationName: 'gateway',
    onError: (err) => log.error({ err: err.message }, 'pg idle client error'),
  });
  const redisOpts = { host: cfg.redis.host, port: cfg.redis.port, username: cfg.redis.user, secrets };
  const redis = createRedis({ ...redisOpts, connectionName: 'gateway' });
  const subscriber = createRedis({ ...redisOpts, connectionName: 'gateway-sse', commandTimeoutMs: 5000 });
  const queueConnection = createRedis({ ...redisOpts, connectionName: 'gateway-wake', maxRetriesPerRequest: null });
  const booking = createHttpClient({
    baseUrl: cfg.bookingUrl,
    timeoutMs: 5000,
    retries: 0,
    headers: { authorization: `Bearer ${secrets.get('booking_service_token')}` },
  });
  const handsTokenKey = createPrivateKey(secrets.get('hands_token_signing_key'));
  if (handsTokenKey.asymmetricKeyType !== 'ed25519') throw new Error('hands_token_signing_key must be Ed25519');
  const gw = await buildGateway({
    pool,
    redis,
    subscriber,
    queueConnection,
    log,
    booking,
    handsTokenKey,
    harnessServiceToken: secrets.get('harness_service_token'),
    cookieSecret: secrets.get('cookie_secret'),
    publicOrigin: cfg.publicOrigin,
    cookieSecure: cfg.cookieSecure,
    agentDeltaMode: cfg.agentDeltaMode,
    publicAllowedPeers: cfg.publicAllowedPeers,
    internalAllowedPeers: cfg.internalAllowedPeers,
    publicBind: cfg.publicBind,
    internalBind: cfg.internalBind,
  });
  gw.sweeper.start();
  log.info({ public: cfg.publicBind, internal: cfg.internalBind }, 'gateway listening');

  const shutdown = async (): Promise<void> => {
    await gw.close();
    await booking.close();
    await pool.end();
    redis.disconnect();
    subscriber.disconnect();
    queueConnection.disconnect();
  };
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  return gw;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startGateway().catch((err: unknown) => {
    // no secret values can be in this message: config/secret errors name keys and paths only
    process.stderr.write(`gateway failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
