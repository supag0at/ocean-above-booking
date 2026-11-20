// Acceptance 6: the contract invariant "a persisted user.message that no run has consumed is processed within
// bounded time" — the five tests listed under A-01 §7.4 (also §6.4 / §11), in real time, with the real sweeper
// (15 s period), real BullMQ and a simulated harness worker that has NO re-check loop (helpers/sim-harness.ts).
// Time bounds come from §7.4: W1 10 s + one period 15 s = 25 s; W2 45 s + 15 s = 60 s; ticket grace 5 s + 15 s = 20 s.
// EXEC_SLACK covers the execution time of one sweeper round + doorbell + worker pickup on top of those bounds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SWEEP_PERIOD_MS } from '@fb/contracts/server';
import { W1_SECONDS, W2_SECONDS, TICKET_GRACE_SECONDS } from '../src/sweeper.ts';
import { Browser, Harness } from './helpers/client.ts';
import { seedQuote, seedTicket, skipReason, sleep, startEnv, type Env } from './helpers/env.ts';
import { newRun, reply, runCompleted, runStarted } from './helpers/fixtures.ts';
import { SimHarness } from './helpers/sim-harness.ts';

const EXEC_SLACK_MS = 1500;
const reason = await skipReason();
if (reason) console.warn(`[gateway invariant tests skipped] ${reason}`);
let env: Env;
let sim: SimHarness;
let h: Harness;
beforeAll(async () => {
  if (reason) return;
  env = await startEnv();
  h = new Harness(env.gw.internalApp);
  sim = new SimHarness({
    // BullMQ blocks in BZPOPMIN for seconds: the command timeout must exceed that (0 does not disable it)
    connection: env.harnessConnection({ maxRetriesPerRequest: null, commandTimeoutMs: 60_000 }),
    fenceRedis: env.harnessRedis,
    harness: h,
  });
  env.gw.sweeper.start(); // the production period, SWEEP_PERIOD_MS
}, 180_000);
afterAll(async () => {
  env?.gw.sweeper.stop();
  await sim?.close();
  await env?.close();
});

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`);
    await sleep(200);
  }
}
async function user(): Promise<{ b: Browser; sid: string }> {
  const b = new Browser(env.gw.publicApp);
  await b.login();
  return { b, sid: await b.newSession('en') };
}
async function row(sid: string): Promise<Record<string, unknown>> {
  return (await env.owner.query('SELECT * FROM app.sessions WHERE id = $1', [sid])).rows[0] as Record<string, unknown>;
}
const runWith = (sid: string, seq: number) => sim.runs.find((r) => r.sessionId === sid && r.inputSeqs.includes(seq));
const scanRings = (sid: string) =>
  env.rings.filter((r) => r.sessionId === sid && r.jobId.startsWith(`wake-${sid}-scan-`));

describe
  .skipIf(reason !== null)
  .concurrent('invariant: unconsumed input is processed in bounded time (A-01 §7.4)', () => {
    it('① a message sent mid-run (its doorbell swallowed by the busy worker) is in a later run’s inputSeqs within 60 s', async () => {
      const { b, sid } = await user();
      sim.holdMs.set(sid, 3000);
      expect((await b.say(sid, 'first')).status).toBe(202);
      await until(() => runWith(sid, 1), 10_000, 'run for seq 1');
      const t2 = Date.now();
      const second = await b.say(sid, 'second, while the run is open');
      expect(second.status).toBe(202);
      const seq = second.body.event.seq as number; // 3: run_started took seq 2
      // the wake job for it really reached the worker and was swallowed (no run for it yet)
      await until(() => sim.wakes.find((w) => w.jobId === `wake-${sid}-${seq}`), 5000, 'wake for the mid-run message');
      expect(runWith(sid, seq)).toBeUndefined();
      const r = await until(() => runWith(sid, seq), 60_000, 'mid-run message consumed');
      expect(r.at - t2).toBeLessThanOrEqual(60_000);
      expect(r.inputSeqs).toEqual([seq]);
      expect(scanRings(sid).length).toBeGreaterThan(0); // picked up through the sweeper, not by luck
      expect(await row(sid)).toMatchObject({
        consumed_up_to_seq: String(seq),
        last_user_seq: String(seq),
        oldest_unconsumed_at: null,
      });
    });

    it('② doorbell lost (BullMQ refused it): still 202; the sweeper rings within 25 s and the input is processed', async () => {
      const { b, sid } = await user();
      env.dropDoorbell.add(sid);
      const t0 = Date.now();
      expect((await b.say(sid, 'hello?')).status).toBe(202);
      expect(await env.admin.exists(`bull:harness-wake:wake-${sid}-1`)).toBe(0);
      await until(() => scanRings(sid)[0], 25_000 + EXEC_SLACK_MS, 'sweeper doorbell');
      const ringAt = Date.now() - t0;
      expect(ringAt).toBeGreaterThanOrEqual(W1_SECONDS * 1000 - 500); // not before W1
      expect(ringAt).toBeLessThanOrEqual(W1_SECONDS * 1000 + SWEEP_PERIOD_MS + EXEC_SLACK_MS);
      const r = await until(() => runWith(sid, 1), 5000, 'processed after the sweeper doorbell');
      expect(r.inputSeqs).toEqual([1]);
    });

    it('③ harness killed mid-run: within 60 s of its last event another worker resumes the run; the dead fence is refused', async () => {
      const { b, sid } = await user();
      env.dropDoorbell.add(sid); // only the dead worker ever sees this message
      expect((await b.say(sid, 'book something')).status).toBe(202);
      const dead = await env.harnessRedis.incr(`lease:fence:${sid}`);
      const run = newRun();
      expect((await h.emit(sid, dead, runStarted(run, [1]))).status).toBe(201);
      const tDeath = Date.now();
      // the run is open, so W1 never applies; nothing rings before W2
      const res = await until(() => sim.resumes.find((x) => x.sessionId === sid), 60_000 + EXEC_SLACK_MS, 'resume');
      expect(res.runId).toBe(run);
      expect(res.at - tDeath).toBeGreaterThanOrEqual(W2_SECONDS * 1000 - 500);
      expect(res.at - tDeath).toBeLessThanOrEqual(W2_SECONDS * 1000 + SWEEP_PERIOD_MS + EXEC_SLACK_MS);
      expect(res.fence).toBeGreaterThan(dead);
      const late = await h.emit(sid, dead, reply(run, 1, 'the zombie wakes up'));
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('FENCE_STALE');
      expect(await row(sid)).toMatchObject({ open_run_id: null, last_run_outcome: 'completed' });
    });

    it('⑤ booking committed but booking.confirmed never written: the sweeper back-fills it within 20 s, once, no doorbell', async () => {
      const { b, sid } = await user();
      const q1 = await seedQuote(env.owner, { userId: b.userId, sessionId: sid, offered: true });
      const q2 = await seedQuote(env.owner, { userId: b.userId, sessionId: sid, offered: true });
      const confirmed = async (qid: string) =>
        (
          await env.owner.query(
            "SELECT actor FROM app.events WHERE session_id = $1 AND idempotency_key = 'booking:' || $2",
            [sid, qid],
          )
        ).rows as { actor: string }[];
      const bound = TICKET_GRACE_SECONDS * 1000 + SWEEP_PERIOD_MS + EXEC_SLACK_MS;
      // path a: booking committed, then the gateway crashed before writing the event (ticket seeded as fb_owner, M-24)
      const t1 = Date.now();
      await seedTicket(env.owner, { userId: b.userId, sessionId: sid, quoteId: q1 });
      // path b: booking committed, its reply was lost; the gateway answered 503 and wrote nothing
      env.booking.mode = 'commit-then-500';
      const lost = await b.raw('POST', `/api/v1/quotes/${q2}/confirm`);
      env.booking.mode = 'normal';
      const t2 = Date.now();
      expect(lost.status).toBe(503);
      expect(await confirmed(q2)).toHaveLength(0);
      await until(async () => ((await confirmed(q1)).length === 1 ? true : undefined), bound, 'back-fill a');
      expect(Date.now() - t1).toBeLessThanOrEqual(bound);
      await until(async () => ((await confirmed(q2)).length === 1 ? true : undefined), bound, 'back-fill b');
      expect(Date.now() - t2).toBeLessThanOrEqual(bound);
      expect((await confirmed(q1))[0]!.actor).toBe('system');
      // a user retry afterwards: alreadyBooked, still exactly one event per quote
      for (const q of [q1, q2]) {
        const retry = await b.raw('POST', `/api/v1/quotes/${q}/confirm`);
        expect(retry.status).toBe(200);
        expect(retry.body.alreadyBooked).toBe(true);
        expect(await confirmed(q)).toHaveLength(1);
      }
      expect(env.rings.filter((r) => r.sessionId === sid)).toEqual([]); // D-39: back-fills never ring
    });
  });

describe.skipIf(reason !== null)('invariant after Redis data loss (FLUSHALL, A-01 §5.1 step 4, §7.4, §11)', () => {
  it('④ old fence refused, new worker accepted, users must log in again, pending input still processed', async () => {
    const { b, sid } = await user();
    env.dropDoorbell.add(sid);
    expect((await b.say(sid, 'one')).status).toBe(202);
    const old = await env.harnessRedis.incr(`lease:fence:${sid}`);
    const run = newRun();
    expect((await h.emit(sid, old, runStarted(run, [1]))).status).toBe(201);
    const t3 = Date.now();
    expect((await b.say(sid, 'two, mid-run')).status).toBe(202); // seq 3, unconsumed

    await env.admin.flushall();

    const stale = await h.emit(sid, old, reply(run, 1, 'old worker after the flush'));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('FENCE_STALE');
    expect(Number(await env.admin.get(`lease:fence:${sid}`))).toBe(old + 1); // max_fence_seen + 1
    expect((await h.emit(sid, old, reply(run, 1, 'again'))).status).toBe(409);
    const fresh = await env.harnessRedis.incr(`lease:fence:${sid}`);
    expect(fresh).toBe(old + 2);
    expect(
      (
        await h.emit(sid, fresh, {
          type: 'agent.run_resumed',
          idempotencyKey: `run:${run}:resumed:2`,
          payload: { runId: run, attempt: 2 },
        })
      ).status,
    ).toBe(201);
    expect((await h.emit(sid, fresh, runCompleted(run))).status).toBe(201);

    // auth:sess:* is gone too: the browser must log in again (§11)
    expect((await b.get('/api/v1/me')).status).toBe(401);

    // seq 3 is still unconsumed in Postgres; the sweeper re-rings (BullMQ re-creates its keys) and it is processed
    const bound = W1_SECONDS * 1000 + SWEEP_PERIOD_MS + EXEC_SLACK_MS;
    const r = await until(() => runWith(sid, 3), bound, 'seq 3 processed after FLUSHALL');
    expect(r.inputSeqs).toEqual([3]);
    expect(r.at - t3).toBeLessThanOrEqual(bound);
    expect(sim.errors.filter((e) => e.startsWith(sid))).toEqual([]);
  });
});

describe.skipIf(reason !== null)('Redis ACL', () => {
  it('no gateway command was refused during this file', async () => {
    expect(await env.aclDenials()).toEqual([]);
  });
});
