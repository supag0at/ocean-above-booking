// The narrowed gateway ACL (src/redis-acl.ts, A-01 §7.2) against real Redis 7 + real BullMQ: every gateway Redis
// path works with zero ACL LOG entries, and anything outside the list (dangerous commands, other key spaces,
// other channels, blocking / scanning commands) is refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, Harness } from './helpers/client.ts';
import { seedQuote, skipReason, sleep, startEnv, type Env } from './helpers/env.ts';
import { newRun, offered, runCompleted, runStarted } from './helpers/fixtures.ts';

const reason = await skipReason();
if (reason) console.warn(`[gateway redis-acl tests skipped] ${reason}`);
let env: Env;
beforeAll(async () => {
  if (!reason) env = await startEnv();
}, 180_000);
afterAll(async () => {
  await env?.close();
});

describe.skipIf(reason !== null)('gateway Redis ACL (narrowed)', () => {
  it('every gateway path runs without a single ACL denial', async () => {
    const b = new Browser(env.gw.publicApp);
    expect((await b.login('acl')).status).toBe(200);
    expect((await b.login('acl')).status).toBe(200); // rotation: DEL + PUBLISH sse:logout
    const sid = await b.newSession('en');
    expect((await b.say(sid, 'one')).status).toBe(202); // HSET/EXPIRE, PUBLISH, BullMQ add
    expect((await b.say(sid, 'two')).status).toBe(202);
    const h = new Harness(env.gw.internalApp);
    const fence = await env.harnessRedis.incr(`lease:fence:${sid}`);
    const run = newRun();
    expect((await h.emit(sid, fence, runStarted(run, [1, 2]))).status).toBe(201); // fence EVAL
    expect((await h.req('POST', `/internal/v1/sessions/${sid}/hands-token`, { fence })).status).toBe(200);
    const qid = await seedQuote(env.owner, { userId: b.userId, sessionId: sid, offered: true, toolCallId: 'tc1' });
    expect((await h.emit(sid, fence, offered(run, qid, 'tc1'))).status).toBe(201);
    expect((await b.raw('POST', `/api/v1/quotes/${qid}/confirm`)).status).toBe(201);
    expect((await h.emit(sid, fence, runCompleted(run))).status).toBe(201);
    // duplicate jobId (BullMQ duplicate branch) and a sweeper round (SET NX PX + scan doorbell)
    expect(await env.realDoorbell.ringForMessage(sid, 1, `00-${'1'.repeat(32)}-${'1'.repeat(16)}-01`)).toBe(true);
    expect((await env.gw.sweeper.runOnce()).locked).toBe(true);
    expect((await env.gw.sweeper.runOnce()).locked).toBe(false);
    // Redis data loss: fence RESET branch (SET inside the script), BullMQ re-creates its keys
    await env.admin.flushall();
    expect(
      (
        await h.emit(sid, fence, {
          type: 'agent.run_resumed',
          idempotencyKey: 'rr',
          payload: { runId: run, attempt: 2 },
        })
      ).status,
    ).toBe(409);
    expect(await env.realDoorbell.ringForMessage(sid, 2, `00-${'2'.repeat(32)}-${'2'.repeat(16)}-01`)).toBe(true);
    expect((await env.gw.sweeper.runOnce()).locked).toBe(true);
    await sleep(300);
    expect(await env.aclDenials()).toEqual([]);
    // the doorbell really landed in BullMQ with the M-7 jobId
    expect(await env.admin.exists(`bull:harness-wake:wake-${sid}-2`)).toBe(1);
  });

  it('refuses everything outside the list', async () => {
    const r = env.redis;
    const refused = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return 'ALLOWED';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const cases: [string, () => Promise<unknown>][] = [
      ['FLUSHALL', () => r.flushall()],
      ['KEYS', () => r.keys('*')],
      ['CONFIG GET', () => r.config('GET', 'maxmemory')],
      ['SCAN', () => r.scan(0)],
      ['CLIENT LIST', () => r.call('CLIENT', 'LIST')],
      ['SCRIPT FLUSH', () => r.call('SCRIPT', 'FLUSH')],
      ['BZPOPMIN', () => r.bzpopmin('bull:harness-wake:x', 0.01)],
      ['lease:session:* (forging a lease)', () => r.set('lease:session:x', '1')],
      ['other key space', () => r.get('app:anything')],
      ['PUBLISH outside sse:*', () => r.call('PUBLISH', 'other', 'x')],
      ['ACL', () => r.call('ACL', 'LIST')],
    ];
    for (const [what, fn] of cases) expect(await refused(fn), what).toMatch(/NOPERM/);
  });
});
