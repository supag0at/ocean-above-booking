// §3.6 step 0 ending reconciliation and step 1 restart limit (§14.1 "结局对账"): crashes between the fixed write steps.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ev } from '../src/events.ts';
import type { EmitEventRequest } from '@fb/contracts/server';
import { createWorld, onJob, type World } from './fakes/world.ts';

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.stop();
});

const P = (e: Ev): Record<string, unknown> => e.payload as unknown as Record<string, unknown>;
const ofT = (evs: Ev[], t: string): Ev[] => evs.filter((e) => e.type === t);

/** Make the first write matching `pred` fail with a 500 (the worker dies there), then let a new worker resume. */
async function crashAt(sid: string, pred: (r: EmitEventRequest) => boolean): Promise<void> {
  let done = false;
  w.session.inject = (r) => {
    if (!done && pred(r)) {
      done = true;
      return 500;
    }
    return undefined;
  };
  await expect(onJob(w.deps('wA'), sid)).rejects.toThrow();
  w.session.inject = undefined;
  w.redis.now = () => Date.now() + 31_000;
}

describe('ending reconciliation', () => {
  it('template written, ending missing → ending from meta.ending, no model call, no run_resumed', async () => {
    const sid = w.session.createSession('en');
    w.session.addUserMessage(sid, 'hi');
    w.llm.script = () => ({ status: 500 });
    await crashAt(sid, (r) => r.type === 'agent.run_failed');
    const calls = w.llm.requests.length;
    expect(await onJob(w.deps('wB'), sid)).toBe('idle');
    const evs = w.session.events(sid);
    expect(w.llm.requests.length).toBe(calls);
    expect(ofT(evs, 'agent.run_resumed')).toEqual([]);
    expect(ofT(evs, 'agent.run_failed').map((e) => [P(e).code, P(e).retryable])).toEqual([['LLM_ERROR', true]]);
  });

  it('guard_violation{replaced} written, template missing → template + run_completed{stop}', async () => {
    const sid = w.session.createSession('zh');
    w.session.addUserMessage(sid, '应该是 $1');
    w.llm.script = () => ({ text: '好的，$1。' });
    await crashAt(sid, (r) => r.type === 'agent.message' && r.idempotencyKey.includes(':guard_fallback'));
    const calls = w.llm.requests.length;
    expect(await onJob(w.deps('wB'), sid)).toBe('idle');
    const evs = w.session.events(sid);
    expect(w.llm.requests.length).toBe(calls);
    const tpl = evs.filter((e) => e.type === 'agent.message' && P(e).meta !== undefined);
    expect(tpl.map((e) => (P(e).meta as { template: string }).template)).toEqual(['guard_fallback']);
    expect(ofT(evs, 'agent.run_completed').map((e) => P(e).endReason)).toEqual(['stop']);
  });

  it('final reply written, run_completed missing → run_completed without a model call', async () => {
    const sid = w.session.createSession('en');
    w.session.addUserMessage(sid, 'hi');
    w.llm.script = () => ({ text: 'Hello! Where to?' });
    await crashAt(sid, (r) => r.type === 'agent.run_completed');
    const calls = w.llm.requests.length;
    expect(await onJob(w.deps('wB'), sid)).toBe('idle');
    const evs = w.session.events(sid);
    expect(w.llm.requests.length).toBe(calls);
    expect(ofT(evs, 'agent.run_resumed').length).toBe(1);
    expect(ofT(evs, 'agent.run_completed').length).toBe(1);
  });

  it('crash after the user message, during the request: resume continues and finishes', async () => {
    const sid = w.session.createSession('en');
    w.session.addUserMessage(sid, 'hi');
    w.llm.script = () => ({ text: 'Hello!' });
    await crashAt(sid, (r) => r.type === 'agent.message');
    expect(await onJob(w.deps('wB'), sid)).toBe('idle');
    const evs = w.session.events(sid);
    expect(ofT(evs, 'agent.run_resumed').map((e) => P(e).attempt)).toEqual([2]);
    expect(evs.filter((e) => e.type === 'agent.message').map((e) => P(e).messageKey)).toEqual([
      expect.stringMatching(/^m:run_[0-9A-Z]+:2:0$/),
    ]);
  });

  it('restart limit: the 4th attempt fills, writes restart_limit and run_failed{RESTART_LIMIT, retryable:false}', async () => {
    const sid = w.session.createSession('en');
    w.session.addUserMessage(sid, 'hi');
    w.llm.script = (b, i) => (i === 0 ? { toolCalls: [{ name: 'list_my_tickets', args: {} }] } : { text: 'x' });
    // every attempt dies right before its toolResult is written
    w.session.inject = (r) =>
      r.type === 'agent.message' && (r.payload as { role: string }).role === 'toolResult' ? 500 : undefined;
    let offset = 0;
    for (let k = 0; k < 3; k++) {
      w.redis.now = () => Date.now() + offset;
      await expect(onJob(w.deps(`w${k}`), sid)).rejects.toThrow();
      offset += 31_000;
    }
    w.session.inject = undefined;
    w.redis.now = () => Date.now() + offset;
    expect(await onJob(w.deps('wZ'), sid)).toBe('idle');
    const evs = w.session.events(sid);
    expect(ofT(evs, 'agent.run_resumed').map((e) => P(e).attempt)).toEqual([2, 3]);
    const filled = evs.filter((e) => e.type === 'agent.message' && P(e).fill !== undefined);
    expect(filled.map((e) => P(e).fill)).toEqual(['interrupted']);
    expect(JSON.parse(P(filled[0] as Ev).messageJson as string).content[0].text).toMatch(
      /^INTERRUPTED: tool "list_my_tickets"/,
    );
    expect(ofT(evs, 'agent.run_failed').map((e) => [P(e).code, P(e).retryable])).toEqual([['RESTART_LIMIT', false]]);
  });
});
