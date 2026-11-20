// Acceptance 3 (T08) + A-01 §5.5: key (session_id, run_id, tool_call_id); concurrent calls with one key commit
// exactly one side effect; different arguments under one key -> IDEMPOTENCY_CONFLICT; hash is key-order independent.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteResponse } from '@fb/contracts/tools';
import type { Quote } from '@fb/contracts/web';
import { inputSha256 } from '../src/engine.ts';
import { startHarness, type Harness } from './support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const N = 12;

async function burst(s: { token: string }, name: string, input: Record<string, unknown>) {
  const ids = { toolCallId: `call_${randomUUID()}`, runId: 'run_BURST' };
  const results = await Promise.all(Array.from({ length: N }, () => h.call(s, name, input, ids)));
  for (const r of results) expect(r).toEqual(results[0]);
  return { results, ...ids };
}

describe('concurrent calls with one key produce one side effect', () => {
  it('quote_route: one quote row, one tool_calls row, identical responses', async () => {
    const s = await h.newSession();
    const { results, toolCallId } = await burst(s, 'quote_route', { from: 'Shanghai', to: 'São Paulo' });
    expect(results[0]?.ok).toBe(true);
    expect(await h.count('quotes', 'session_id = $1', [s.sid])).toBe(1);
    expect(await h.count('tool_calls', 'session_id = $1 AND tool_call_id = $2', [s.sid, toolCallId])).toBe(1);
  });

  it('offer_booking: one quote_offers row', async () => {
    const s = await h.newSession();
    const q = (await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' })) as ExecuteResponse & { data: Quote };
    await burst(s, 'offer_booking', { quoteId: q.data.quoteId });
    expect(await h.count('quote_offers', 'quote_id = $1', [q.data.quoteId])).toBe(1);
  });

  it('save_preference / forget_preference: one memory row each', async () => {
    const s = await h.newSession();
    await burst(s, 'save_preference', { key: 'home_city', value: 'tokyo' });
    expect(await h.count('user_memories', 'user_id = $1', [s.uid])).toBe(1);
    await burst(s, 'forget_preference', { key: 'home_city' });
    expect(await h.count('user_memories', 'user_id = $1', [s.uid])).toBe(2);
  });
});

describe('IDEMPOTENCY_CONFLICT', () => {
  it('same key with different input or different tool name is rejected and not cached', async () => {
    const s = await h.newSession();
    const ids = { toolCallId: `call_${randomUUID()}`, runId: 'run_C' };
    const first = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }, ids);
    const conflict = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Tokyo' }, ids);
    expect(conflict).toEqual({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        llmText: 'This toolCallId was already used with different arguments. Do not reuse tool call ids.',
      },
    });
    const otherName = await h.call(s, 'resolve_city', { original: 'x', candidates: ['Dubai'] }, ids);
    expect(otherName.ok === false && otherName.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await h.count('quotes', 'session_id = $1', [s.sid])).toBe(1);
    expect(await h.count('tool_calls', 'session_id = $1', [s.sid])).toBe(1);
    // the original arguments still replay the original response
    expect(await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }, ids)).toEqual(first);
  });
});

describe('key scope', () => {
  it('the same toolCallId in another run is a new call (S-15: vendor ids are not unique across runs)', async () => {
    const s = await h.newSession();
    const toolCallId = `call_${randomUUID()}`;
    const a = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }, { toolCallId, runId: 'run_A' });
    const b = await h.call(s, 'quote_route', { from: 'Shanghai', to: 'Dubai' }, { toolCallId, runId: 'run_B' });
    expect(a.ok && b.ok && a.data.quoteId !== b.data.quoteId).toBe(true);
    expect(await h.count('quotes', 'session_id = $1', [s.sid])).toBe(2);
  });

  it('the same toolCallId in another session is a new call', async () => {
    const s1 = await h.newSession();
    const s2 = await h.newSession({ userId: s1.uid });
    const ids = { toolCallId: `call_${randomUUID()}`, runId: 'run_S' };
    await h.call(s1, 'save_preference', { key: 'preferred_language', value: 'en' }, ids);
    await h.call(s2, 'save_preference', { key: 'preferred_language', value: 'en' }, ids);
    expect(await h.count('user_memories', 'user_id = $1', [s1.uid])).toBe(2);
  });
});

describe('key-order round trip (A-01 §5.5, I-5)', () => {
  it('canonical hash ignores key order at every depth', () => {
    expect(inputSha256({ a: 1, b: { c: [1, { x: 1, y: 2 }], d: 'é' } })).toBe(
      inputSha256({ b: { d: 'é', c: [1, { y: 2, x: 1 }] }, a: 1 }),
    );
    expect(inputSha256({ a: [1, 2] })).not.toBe(inputSha256({ a: [2, 1] }));
  });

  it('a replay with reordered keys (as read back from jsonb) hits the cache, not a conflict', async () => {
    const s = await h.newSession();
    const ids = { toolCallId: `call_${randomUUID()}`, runId: 'run_K' };
    const first = await h.call(s, 'resolve_city', { original: 'São Paulo', candidates: ['Sao Paulo'] }, ids);
    const again = await h.call(s, 'resolve_city', { candidates: ['Sao Paulo'], original: 'São Paulo' }, ids);
    expect(again).toEqual(first);
    expect(await h.count('tool_calls', 'session_id = $1', [s.sid])).toBe(1);
  });
});
