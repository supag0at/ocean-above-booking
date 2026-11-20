// Acceptance 4 + 5 on a REAL redis:7 (lease / fence Lua scripts, fence read by the session stand-in, ephemeral
// publishes): surplus doorbells never make the holder stale; a worker killed during tool execution is taken over and
// its late writes are fenced out. Starts its own redis:7 container (D-74: no Docker means failure, not a skip).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from '@fb/platform/redis';
import type { Ev } from '../src/events.ts';
import { fenceKey, leaseKey } from '../src/lease.ts';
import { danglingToolCalls, project, toolCallsOf } from '../src/projector.ts';
import type { ChatRequest, ScriptedReply } from './fakes/llm-server.ts';
import { startRealRedis } from './fakes/real-redis.ts';
import { createWorld, onJob, type World } from './fakes/world.ts';

let real: Redis;
let stopRedis: () => Promise<void>;
let w: World | undefined;
const used: string[] = [];

beforeAll(async () => {
  const started = await startRealRedis();
  real = started.redis;
  stopRedis = started.stop;
});
afterEach(async () => {
  if (w !== undefined) {
    w.hands.frozen = false;
    await w.stop();
    w = undefined;
  }
});
afterAll(async () => {
  if (used.length > 0) await real.del(...used.flatMap((s) => [leaseKey(s), fenceKey(s)]));
  real.disconnect();
  await stopRedis();
});

const P = (e: Ev): Record<string, unknown> => e.payload as unknown as Record<string, unknown>;
const msgs = (evs: Ev[], role: string): Ev[] => evs.filter((e) => e.type === 'agent.message' && P(e).role === role);
const ofT = (evs: Ev[], t: string): Ev[] => evs.filter((e) => e.type === t);
const qid = (b: ChatRequest): string =>
  /q_[0-9A-Z]{26}/.exec(JSON.stringify(b.messages.at(-1)?.content ?? ''))?.[0] ?? 'q_x';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await sleep(5);
  }
}

describe('lease, fence and crash takeover on real redis:7', () => {
  it('5 surplus doorbells during a run never make the holder stale', async () => {
    w = await createWorld({ realRedis: real });
    const sid = w.session.createSession('en');
    used.push(sid);
    w.session.addUserMessage(sid, 'Shanghai to Tokyo please');
    let release!: () => void;
    w.hands.gates.set('quote_route', new Promise<void>((r) => (release = r)));
    w.llm.script = (b, i) =>
      [
        { toolCalls: [{ name: 'quote_route', args: { from: 'Shanghai', to: 'Tokyo' } }] },
        { text: 'Your quote is on the card.' },
      ][i] ?? { text: 'x' };
    let hit = false;
    w.hands.onGateHit = () => (hit = true);
    const holder = onJob(w.deps('wA'), sid);
    await until(() => hit);
    const world = w;
    const extra = await Promise.all([1, 2, 3, 4, 5].map((i) => onJob(world.deps(`wX${i}`), sid)));
    expect(extra).toEqual(Array(5).fill('not_acquired'));
    expect(await real.get(fenceKey(sid))).toBe('1');
    release();
    expect(await holder).toBe('idle');
    expect(w.session.emitLog.filter((x) => x.status === 409)).toEqual([]);
    expect(ofT(w.session.events(sid), 'agent.run_completed').length).toBe(1);
    expect(await real.exists(leaseKey(sid))).toBe(0); // released at the end of the job
  });

  it('killed during tool execution: another worker takes over, pairing stays complete, the stale worker is fenced out', async () => {
    w = await createWorld({ realRedis: real });
    const sid = w.session.createSession('zh');
    used.push(sid);
    w.session.addUserMessage(sid, '从上海飞圣保罗');
    let releaseA!: () => void;
    let gateHit = false;
    w.hands.gates.set('quote_route', new Promise<void>((r) => (releaseA = r)));
    const world = w;
    w.hands.onGateHit = () => {
      gateHit = true;
      world.hands.gates.delete('quote_route'); // only worker A's first call blocks
    };
    w.llm.script = (b, i) => {
      const s: ScriptedReply[] = [
        {
          text: '查询中',
          toolCalls: [
            { name: 'resolve_city', args: { original: '上海', candidates: ['Shanghai'] } },
            { name: 'quote_route', args: { from: 'Shanghai', to: 'São Paulo' } },
          ],
        },
        { toolCalls: [{ name: 'offer_booking', args: { quoteId: qid(b) } }] },
        { text: '请看报价卡并点击按钮下单。' },
      ];
      const offset = i >= 1 && JSON.stringify(b.messages).includes('Booking card shown') ? 2 : i >= 1 ? 1 : 0;
      return s[offset] ?? { text: 'x' };
    };
    const a = onJob(w.deps('wA'), sid);
    await until(() => gateHit);
    expect(await real.get(leaseKey(sid))).toBe('wA:1');
    // "kill" A: it stops renewing and its lease expires. Expiry is simulated with DEL because the Docker Desktop VM
    // clock is stepped on this machine (see lease.test.ts); the Lua scripts and the fence are the real ones.
    await real.del(leaseKey(sid));
    expect(await onJob(w.deps('wB'), sid)).toBe('idle');
    expect(await real.get(fenceKey(sid))).toBe('2');
    const evs = w.session.events(sid);
    expect(ofT(evs, 'agent.run_resumed').map((e) => P(e).attempt)).toEqual([2]);
    expect(
      msgs(evs, 'toolResult')
        .filter((e) => P(e).fill !== undefined)
        .map((e) => [P(e).toolName, P(e).fill]),
    ).toEqual([
      ['resolve_city', 'replayed'],
      ['quote_route', 'replayed'],
    ]);
    expect(ofT(evs, 'quote.offered').length).toBe(1);
    expect(ofT(evs, 'agent.run_completed').length).toBe(1);
    // pairing: every toolCall in the log has exactly one toolResult; the final projection has no dangling call
    const calls = new Map<string, number>();
    for (const e of msgs(evs, 'assistant')) {
      for (const c of toolCallsOf(JSON.parse(P(e).messageJson as string))) calls.set(c.id, 0);
    }
    for (const e of msgs(evs, 'toolResult')) {
      const id = String(P(e).toolCallId);
      expect(calls.has(id), `result without call ${id}`).toBe(true);
      calls.set(id, (calls.get(id) ?? 0) + 1);
    }
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(calls.size).toBe(3);
    expect(danglingToolCalls(project(evs))).toEqual([]);

    // the zombie wakes up: its writes carry fence 1 < 2 and are rejected; it stops without writing anything
    const before = evs.length;
    releaseA();
    expect(await a).toBe('lease_lost');
    expect(w.session.events(sid).length).toBe(before);
    expect(w.session.emitLog.some((x) => x.fence === 1 && x.status === 409)).toBe(true);
    expect(await real.exists(leaseKey(sid))).toBe(0); // A's release did not touch anything (B already released)
  });
});
