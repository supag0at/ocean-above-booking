// Lease + fence (A-02 §3.2, §14.1 "租约"): the same contract suite runs against the in-memory FakeRedis and a REAL
// redis:7. The real half starts its own container (D-74: no Docker means the suite fails, it does not skip).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from '@fb/platform/redis';
import { fenceKey, LeaseKeeper, leaseKey, LeaseStore, type LeaseRedis } from '../src/lease.ts';
import { startRealRedis } from './fakes/real-redis.ts';
import { FakeRedis } from './fakes/redis.ts';

let real: Redis | undefined;
let stopRedis: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const started = await startRealRedis();
  real = started.redis;
  stopRedis = started.stop;
});
afterAll(async () => {
  real?.disconnect();
  await stopRedis?.();
});

interface Backend {
  name: string;
  redis: () => LeaseRedis & { get?: (k: string) => unknown };
  getFence: (sid: string) => Promise<number>;
  available: () => boolean;
}
const fake = new FakeRedis();
const backends: Backend[] = [
  {
    name: 'FakeRedis',
    redis: () => fake,
    getFence: async (s) => Number(fake.get(fenceKey(s)) ?? 0),
    available: () => true,
  },
  {
    name: 'real redis:7',
    redis: () => real as unknown as LeaseRedis,
    getFence: async (s) => Number((await real?.get(fenceKey(s))) ?? 0),
    available: () => true,
  },
];

const sid = (): string => `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function expire(b: Backend, s: string): Promise<void> {
  if (b.name === 'FakeRedis') fake.del(leaseKey(s));
  else await real?.del(leaseKey(s));
}

describe.each(backends)('lease on $name', (b) => {
  it('acquire increments the fence only on success; a failed acquire leaves it untouched', async (ctx) => {
    if (!b.available()) return ctx.skip();
    const s = sid();
    const a = await new LeaseStore(b.redis(), 'wA').acquire(s);
    expect(a?.fence).toBe(1);
    expect(a?.value).toBe('wA:1');
    // 5 surplus doorbells while the holder runs: none acquires, the fence stays 1 (holder never becomes stale)
    for (let i = 0; i < 5; i++) expect(await new LeaseStore(b.redis(), `wX${i}`).acquire(s)).toBeNull();
    expect(await b.getFence(s)).toBe(1);
  });

  it('renew and release only act on our own value', async (ctx) => {
    if (!b.available()) return ctx.skip();
    const s = sid();
    const storeA = new LeaseStore(b.redis(), 'wA', 60_000);
    const a = await storeA.acquire(s);
    if (a === null) throw new Error('no lease');
    expect(await storeA.renew(a)).toBe(true);
    // expiry is simulated with DEL: the Docker Desktop VM clock is stepped by several seconds on this machine
    // (observed: container TIME ~11s behind the host, keys expiring early), so real-time TTL waits are unreliable
    await expire(b, s);
    const storeB = new LeaseStore(b.redis(), 'wB', 5000);
    const bl = await storeB.acquire(s);
    expect(bl?.fence).toBe(2);
    expect(await storeA.renew(a)).toBe(false); // value is wB:2 now
    expect(await storeA.release(a)).toBe(false); // does NOT delete B's lease
    expect(await new LeaseStore(b.redis(), 'wC').acquire(s)).toBeNull();
    expect(await storeB.release(bl as NonNullable<typeof bl>)).toBe(true);
    expect((await new LeaseStore(b.redis(), 'wC').acquire(s))?.fence).toBe(3);
  });

  it('LeaseKeeper keeps the lease alive and reports loss once', async (ctx) => {
    if (!b.available()) return ctx.skip();
    const s = sid();
    // long TTL: see the clock note above; "renewals outlive the TTL" is checked on FakeRedis below
    const store = new LeaseStore(b.redis(), 'wA', 60_000);
    const lease = await store.acquire(s);
    if (lease === null) throw new Error('no lease');
    const keeper = new LeaseKeeper(store, lease, 50);
    let lost = 0;
    keeper.onLost(() => lost++);
    keeper.start();
    await sleep(300);
    expect(await store.renew(lease)).toBe(true);
    expect(await new LeaseStore(b.redis(), 'wB').acquire(s)).toBeNull();
    expect(keeper.lost).toBe(false);
    // someone steals it (simulates expiry during a GC pause)
    await expire(b, s);
    await new LeaseStore(b.redis(), 'wB', 5000).acquire(s);
    await sleep(150);
    expect(keeper.lost).toBe(true);
    expect(lost).toBe(1);
    await keeper.stopAndRelease();
    expect(await new LeaseStore(b.redis(), 'wC').acquire(s)).toBeNull(); // B's lease survived A's release
  });
});

describe('LeaseKeeper on FakeRedis (no VM clock)', () => {
  it('renewals keep a lease alive well past its TTL', async () => {
    const s = sid();
    const store = new LeaseStore(fake, 'wA', 200);
    const lease = await store.acquire(s);
    if (lease === null) throw new Error('no lease');
    const keeper = new LeaseKeeper(store, lease, 50);
    keeper.start();
    await sleep(700);
    expect(await new LeaseStore(fake, 'wB').acquire(s)).toBeNull();
    expect(keeper.lost).toBe(false);
    await keeper.stopAndRelease();
    expect((await new LeaseStore(fake, 'wB').acquire(s))?.fence).toBe(2);
  });
});
