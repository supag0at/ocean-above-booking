import { randomUUID } from 'node:crypto';
import { ALL_TOOLS, type ExecuteResponse } from '@fb/contracts/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './support/harness.ts';

let h: Harness;
let s: { sid: string; uid: string; token: string };

beforeAll(async () => {
  h = await startHarness();
  s = await h.newSession();
});
afterAll(async () => {
  await h?.close();
});

const validEnvelope = (): Record<string, unknown> => ({
  name: 'list_my_tickets',
  input: {},
  toolCallId: `call_${randomUUID()}`,
  runId: 'run_ENV',
  inputSeq: 3,
});

const omit = (e: Record<string, unknown>, k: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(e).filter(([key]) => key !== k));

function expectShape(r: ExecuteResponse): void {
  expect(typeof r.ok).toBe('boolean');
  if (r.ok) {
    expect(typeof r.llmText).toBe('string');
  } else {
    expect(typeof r.error.code).toBe('string');
    expect(typeof r.error.llmText).toBe('string');
    expect(r.error.llmText.length).toBeGreaterThan(0);
  }
}

async function exec(name: string, input: Record<string, unknown>): Promise<ExecuteResponse> {
  const r = await h.call(s, name, input);
  expectShape(r);
  return r;
}

describe('A. envelope rejected with 400 and no tool_calls row', () => {
  const bad: [string, (e: Record<string, unknown>) => unknown][] = [
    ['extra top-level field userId', (e) => ({ ...e, userId: randomUUID() })],
    ['missing name', (e) => omit(e, 'name')],
    ['missing input', (e) => omit(e, 'input')],
    ['missing toolCallId', (e) => omit(e, 'toolCallId')],
    ['missing runId', (e) => omit(e, 'runId')],
    ['missing inputSeq', (e) => omit(e, 'inputSeq')],
    ['inputSeq string', (e) => ({ ...e, inputSeq: '3' })],
    ['inputSeq 2.5', (e) => ({ ...e, inputSeq: 2.5 })],
    ['inputSeq 0', (e) => ({ ...e, inputSeq: 0 })],
    ['input array', (e) => ({ ...e, input: [] })],
    ['input string', (e) => ({ ...e, input: 'x' })],
    ['name number', (e) => ({ ...e, name: 5 })],
    ['empty toolCallId', (e) => ({ ...e, toolCallId: '' })],
  ];
  it.each(bad)('%s', async (_label, mutate) => {
    const before = await h.count('tool_calls');
    const r = await h.post(s.token, mutate(validEnvelope()));
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect(await h.count('tool_calls')).toBe(before);
  });
});

describe('B. inputSeq beyond last_user_seq', () => {
  it('returns 400 VALIDATION_FAILED and no row', async () => {
    const before = await h.count('tool_calls');
    const r = await h.post(s.token, { ...validEnvelope(), inputSeq: 6 });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect(await h.count('tool_calls')).toBe(before);
  });
});

describe('C. tool arguments invalid -> 200 INVALID_INPUT', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['resolve_city', 'candidates wrong type', { original: 'x', candidates: [1] }],
    ['resolve_city', 'extra field', { original: 'x', candidates: ['A'], extra: 1 }],
    ['resolve_city', '4 candidates', { original: 'x', candidates: ['A', 'B', 'C', 'D'] }],
    ['resolve_city', 'missing candidates', { original: 'x' }],
    ['quote_route', 'to wrong type', { from: 'Shanghai', to: 1 }],
    ['quote_route', 'extra field', { from: 'Shanghai', to: 'Tokyo', via: 'Paris' }],
    ['offer_booking', 'quoteId wrong type', { quoteId: 5 }],
    ['offer_booking', 'extra field', { quoteId: 'q_1', extra: true }],
    ['list_my_tickets', 'limit string', { limit: '5' }],
    ['list_my_tickets', 'limit 2.5', { limit: 2.5 }],
    ['list_my_tickets', 'limit 0', { limit: 0 }],
    ['list_my_tickets', 'limit 51', { limit: 51 }],
    ['list_my_tickets', 'extra field', { extra: 1 }],
    ['list_my_tickets', 'identity smuggling userId', { limit: 5, userId: randomUUID() }],
    ['save_preference', 'extra field', { key: 'home_city', value: 'Shanghai', note: 'x' }],
    ['save_preference', 'value wrong type', { key: 'auto_book', value: 'true' }],
    ['save_preference', 'language not allowed', { key: 'preferred_language', value: 'fr' }],
    ['forget_preference', 'unknown key', { key: 'x' }],
    ['forget_preference', 'extra field', { key: 'home_city', extra: 1 }],
  ];

  it('covers every tool', () => {
    for (const t of ALL_TOOLS) expect(cases.some(([n]) => n === t.name)).toBe(true);
  });

  it.each(cases)('%s: %s', async (name, _label, input) => {
    const r = await exec(name, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('is cached: one tool_calls row per call', async () => {
    const before = await h.count('tool_calls');
    const r = await exec('quote_route', { from: 'Shanghai', to: 99 });
    expect(r.ok).toBe(false);
    expect(await h.count('tool_calls')).toBe(before + 1);
  });
});

describe('D. unknown tools and sys.profile_snapshot', () => {
  it.each(['book_ticket', 'sys.whatever'])('%s -> UNKNOWN_TOOL', async (name) => {
    const r = await exec(name, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_TOOL');
  });

  it('sys.profile_snapshot with extra input -> INVALID_INPUT', async () => {
    const r = await exec('sys.profile_snapshot', { x: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('sys.profile_snapshot with {} -> ok and no tool_calls row', async () => {
    const before = await h.count('tool_calls');
    const r = await exec('sys.profile_snapshot', {});
    expect(r.ok).toBe(true);
    expect(await h.count('tool_calls')).toBe(before);
  });
});

describe('E. body size', () => {
  it('rejects a body over 16 KB with 413', async () => {
    const r = await h.post(s.token, {
      ...validEnvelope(),
      name: 'resolve_city',
      input: { original: 'x'.repeat(20000), candidates: ['A'] },
    });
    expect(r.status).toBe(413);
  });
});
