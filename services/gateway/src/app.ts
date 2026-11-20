// Wiring: two Fastify instances (one per port, A-01 §2.2) + SSE hub + sweeper, all from injected dependencies so
// tests can run the real code against throw-away Postgres / Redis and a fake booking.
import { buildServer, createServer, type FastifyInstance } from '@fb/platform/fastify';
import type { HttpClient } from '@fb/platform/http';
import type { Logger } from '@fb/platform/log';
import type { Redis } from '@fb/platform/redis';
import { AuthStore } from './auth.ts';
import type { GatewayContext } from './context.ts';
import type { Pool } from './db.ts';
import { createDoorbell, createNotifier, type Doorbell } from './doorbell.ts';
import type { KeyObject } from 'node:crypto';
import { registerPublicRoutes } from './public-routes.ts';
import { INTERNAL_BODY_LIMIT, registerSessionApi } from './session-api.ts';
import { SseHub } from './sse.ts';
import { Sweeper } from './sweeper.ts';

export interface GatewayDeps {
  readonly pool: Pool;
  /** command connection (auth:*, lease:fence:*, sweeper:lock, PUBLISH) */
  readonly redis: Redis;
  /** dedicated connection for SSE subscriptions */
  readonly subscriber: Redis;
  /** dedicated connection for the BullMQ producer */
  readonly queueConnection: Redis;
  readonly log: Logger;
  readonly booking: HttpClient;
  /** Ed25519 private key (hands_token_signing_key); tokens are signed with @fb/contracts/server signHandsToken */
  readonly handsTokenKey: KeyObject;
  readonly harnessServiceToken: string;
  readonly cookieSecret: string;
  readonly publicOrigin: string;
  readonly cookieSecure: boolean;
  readonly agentDeltaMode: 'stream' | 'off';
  readonly publicAllowedPeers: readonly string[];
  readonly internalAllowedPeers: readonly string[];
  /** when set, the servers listen (production); otherwise they are only built (tests listen themselves) */
  readonly publicBind?: string;
  readonly internalBind?: string;
  readonly sseHeartbeatMs?: number;
  /** override for tests (e.g. a doorbell that records jobs) */
  readonly doorbell?: Doorbell;
}

export interface Gateway {
  readonly publicApp: FastifyInstance;
  readonly internalApp: FastifyInstance;
  readonly sweeper: Sweeper;
  readonly sse: SseHub;
  readonly ctx: GatewayContext;
  close(): Promise<void>;
}

export async function buildGateway(d: GatewayDeps): Promise<Gateway> {
  const doorbell = d.doorbell ?? createDoorbell(d.queueConnection, d.log);
  const notifier = createNotifier(d.redis, d.log);
  const sse = new SseHub({
    pool: d.pool,
    redis: d.redis,
    subscriber: d.subscriber,
    log: d.log,
    agentDeltaMode: d.agentDeltaMode,
    ...(d.sseHeartbeatMs !== undefined ? { heartbeatMs: d.sseHeartbeatMs } : {}),
  });
  await sse.start();
  const ctx: GatewayContext = {
    pool: d.pool,
    redis: d.redis,
    log: d.log,
    auth: new AuthStore(d.redis, d.cookieSecret),
    doorbell,
    notifier,
    sse,
    booking: d.booking,
    handsTokenKey: d.handsTokenKey,
    harnessServiceToken: d.harnessServiceToken,
    publicOrigin: d.publicOrigin,
    cookieSecure: d.cookieSecure,
  };
  const ready = async (): Promise<void> => {
    await d.pool.query('SELECT 1');
    if ((await d.redis.ping()) !== 'PONG') throw new Error('redis not ready');
  };

  const publicOpts = {
    allowedPeers: d.publicAllowedPeers,
    trustProxy: true, // only X-Forwarded-For from caddy, for logs; the peer check ignores it
    logger: d.log,
    ready,
    routes: (app: FastifyInstance) => registerPublicRoutes(app, ctx),
  };
  const internalOpts = {
    allowedPeers: d.internalAllowedPeers,
    logger: d.log,
    ready,
    bodyLimit: INTERNAL_BODY_LIMIT,
    routes: (app: FastifyInstance) => registerSessionApi(app, ctx),
  };
  const publicApp = d.publicBind
    ? await createServer({ ...publicOpts, bind: d.publicBind })
    : await buildServer(publicOpts);
  const internalApp = d.internalBind
    ? await createServer({ ...internalOpts, bind: d.internalBind })
    : await buildServer(internalOpts);

  const sweeper = new Sweeper({ pool: d.pool, redis: d.redis, doorbell, notifier, log: d.log });

  return {
    publicApp,
    internalApp,
    sweeper,
    sse,
    ctx,
    async close() {
      sweeper.stop();
      await sse.stop();
      await publicApp.close();
      await internalApp.close();
      await doorbell.close();
    },
  };
}
