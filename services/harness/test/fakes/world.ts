// Wires the stand-ins together: fake Redis + fake session API (HTTP) + fake hands + fake LLM server (HTTP).
import { createHttpClient } from '@fb/platform/http';
import { HttpSessionApi, RedisEphemeralPublisher } from '../../src/http.ts';
import type { Redis } from '@fb/platform/redis';
import { fenceKey, LeaseStore, type LeaseRedis } from '../../src/lease.ts';
import { createLlm } from '../../src/llm/runtime.ts';
import type { EphemeralPublisher, Hands, SessionApi } from '../../src/ports.ts';
import { onJob, type HarnessDeps } from '../../src/runner.ts';
import { FakeHands } from './hands.ts';
import { FakeLlmServer } from './llm-server.ts';
import { FakeRedis } from './redis.ts';
import { FakeSessionApi, SERVICE_TOKEN } from './session.ts';

export interface World {
  redis: FakeRedis;
  session: FakeSessionApi;
  hands: FakeHands;
  llm: FakeLlmServer;
  deps(workerId: string, over?: Partial<HarnessDeps>): HarnessDeps;
  stop(): Promise<void>;
}

/**
 * `realRedis`: leases, fences (as read by the fake session API) and ephemeral publishes go to a REAL redis:7 instead of
 * the in-memory stand-in (`w.redis` then only stays as an unused stand-in; its `now` / `published` do not apply).
 */
export async function createWorld(opts: { realRedis?: Redis } = {}): Promise<World> {
  const redis = new FakeRedis();
  const real = opts.realRedis;
  const session = new FakeSessionApi(
    real === undefined ? redis : async (sid) => Number((await real.get(fenceKey(sid))) ?? '0'),
  );
  await session.start();
  const llmServer = new FakeLlmServer();
  await llmServer.start();
  const hands = new FakeHands();
  const http = createHttpClient({ baseUrl: session.baseUrl, retries: 0 });
  const llm = createLlm({ baseUrl: llmServer.baseUrl, apiKey: () => 'test-key' });
  return {
    redis,
    session,
    hands,
    llm: llmServer,
    deps(workerId, over = {}) {
      return {
        session: new HttpSessionApi(http, SERVICE_TOKEN) as SessionApi,
        hands: hands as Hands,
        publisher: new RedisEphemeralPublisher(real ?? redis) as EphemeralPublisher,
        leases: new LeaseStore((real as LeaseRedis | undefined) ?? redis, workerId),
        llm,
        llmRetryDelaysMs: [1, 1],
        handsRetryDelaysMs: [1, 1],
        now: () => new Date('2026-11-19T08:00:00.000Z'),
        ...over,
      };
    },
    async stop() {
      await http.close();
      await session.stop();
      await llmServer.stop();
    },
  };
}

export { onJob };
