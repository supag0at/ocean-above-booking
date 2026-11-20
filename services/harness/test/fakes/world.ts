// Wires the stand-ins together: fake Redis + fake session API (HTTP) + fake hands + fake LLM server (HTTP).
import { createHttpClient } from '@fb/platform/http';
import { HttpSessionApi, RedisEphemeralPublisher } from '../../src/http.ts';
import { LeaseStore } from '../../src/lease.ts';
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

export async function createWorld(): Promise<World> {
  const redis = new FakeRedis();
  const session = new FakeSessionApi(redis);
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
        publisher: new RedisEphemeralPublisher(redis) as EphemeralPublisher,
        leases: new LeaseStore(redis, workerId),
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
