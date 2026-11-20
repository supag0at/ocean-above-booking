// Process wiring. flight-core and memory are injected: in W3 they are not implemented yet (T03/T10), so the
// container entry point that calls startHands with the real `createFlightCore(locationsDbPath)` and
// `buildProfile` is added at W4 integration. locations.db is opened read-only by flight-core (H-03).
import { readFileSync } from 'node:fs';
import { createLogger } from '@fb/platform/log';
import { createPgPool } from '@fb/platform/pg';
import { FileSecretProvider } from '@fb/platform/secrets';
import { createServer, type FastifyInstance } from '@fb/platform/fastify';
import { publicKeyMap } from './auth.ts';
import { loadHandsConfig, type HandsConfig } from './config.ts';
import type { FlightCore, ProfileBuilder } from './ports.ts';
import { handsServerOptions } from './server.ts';

export interface StartHandsOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createFlightCore: (cfg: HandsConfig) => FlightCore;
  readonly buildProfile: ProfileBuilder;
}

export async function startHands(o: StartHandsOptions): Promise<FastifyInstance> {
  const cfg = loadHandsConfig(o.env);
  const secrets = new FileSecretProvider({ files: { pg_password: 'pg_hands_password' }, preload: ['pg_password'] });
  const logger = createLogger({ service: 'hands', level: cfg.logLevel, secretValues: () => secrets.values() });
  const publicKeys = publicKeyMap(cfg.publicKeyPaths.map((p) => readFileSync(p, 'utf8')));
  const flightCore = o.createFlightCore(cfg); // refuses to start on a locations.db sha256 mismatch (CT-10)
  const pool = createPgPool({
    host: cfg.pgHost,
    port: cfg.pgPort,
    database: cfg.pgDatabase,
    user: cfg.pgUser,
    secrets,
    applicationName: 'hands',
    onError: (err) => logger.error({ err }, 'pg idle client error'),
  });
  const options = handsServerOptions({
    pool,
    deps: { flightCore, buildProfile: o.buildProfile },
    publicKeys,
    allowedPeers: cfg.allowedPeers,
    logger,
  });
  // listens on the fixed interface address only (A-01 §2.2); a missing address fails startup
  return createServer({ ...options, bind: cfg.bind });
}
