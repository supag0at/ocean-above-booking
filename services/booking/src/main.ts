// booking process entry (container CMD: `node services/booking/src/main.ts`).
// Fail closed: missing config, a missing secret file, or an absent bind address all abort startup.
import { pathToFileURL } from 'node:url';
import { parseBind } from '@fb/platform/fastify';
import { createLogger } from '@fb/platform/log';
import { createPgPool } from '@fb/platform/pg';
import { FileSecretProvider } from '@fb/platform/secrets';
import { BOOKING_SECRET_FILES, loadBookingConfig } from './config.ts';
import { buildBookingApp } from './server.ts';

export async function main(): Promise<void> {
  const config = loadBookingConfig();
  // /run/secrets only (A-01 §2.3); preload so a missing file fails startup (A-01 §2.4)
  const secrets = new FileSecretProvider({
    files: BOOKING_SECRET_FILES,
    preload: ['pg_password', 'booking_service_token'],
  });
  const logger = createLogger({ service: 'booking', level: config.logLevel, secretValues: () => secrets.values() });
  const pool = createPgPool({
    host: config.pgHost,
    port: config.pgPort,
    database: config.pgDatabase,
    user: config.pgUser,
    secrets,
    applicationName: 'booking',
    onError: (err) => logger.warn({ err }, 'pg idle client error'),
  });

  const app = await buildBookingApp({
    pool,
    serviceToken: secrets.get('booking_service_token'),
    allowedPeers: config.allowedPeers,
    logger,
  });
  // concrete interface address; listen rejects if it does not exist on this host (fail closed, A-01 §2.2)
  await app.listen(parseBind(config.bind));
  logger.info({ bind: config.bind }, 'booking listening');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'booking shutting down');
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    // no logger yet when config / secrets fail; the message never contains secret values
    process.stderr.write(`booking: startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
