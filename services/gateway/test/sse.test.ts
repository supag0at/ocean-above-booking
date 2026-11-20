// Acceptance 3: SSE resume with Last-Event-ID (A-01 §4.4), plus the rest of the SSE contract: backlog-then-live
// without gaps or duplicates, public view only, status frames, ephemeral filtering (schema / session / fence / size,
// M-17 no fence to the browser) and logout closing the stream (S-4). Runs against a listening gateway.
import { PublicEphemeralSchema, PublicEventSchema, SSE_RETRY_MS } from '@fb/contracts/web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/validate.ts';
import { Browser, Harness } from './helpers/client.ts';
import { skipReason, sleep, startEnv, type Env } from './helpers/env.ts';
import { newRun, reply, runStarted } from './helpers/fixtures.ts';
import { SseClient } from './helpers/sse.ts';

const reason = await skipReason();
if (reason) console.warn(`[gateway sse tests skipped] ${reason}`);
let env: Env;
let base = '';
const open: SseClient[] = [];
beforeAll(async () => {
  if (reason) return;
  env = await startEnv();
  await env.gw.publicApp.listen({ host: '127.0.0.1', port: 0 });
  const addr = env.gw.publicApp.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 180_000);
afterAll(async () => {
  for (const c of open) c.close();
  await env?.close();
});

async function stream(
  b: Browser,
  sid: string,
  o: { afterSeq?: number; lastEventId?: string } = {},
): Promise<SseClient> {
  const headers: Record<string, string> = { cookie: b.cookieHeader() };
  if (o.lastEventId !== undefined) headers['last-event-id'] = o.lastEventId;
  const q = o.afterSeq !== undefined ? `?afterSeq=${o.afterSeq}` : '';
  const c = await SseClient.open(`${base}/api/v1/sessions/${sid}/stream${q}`, headers);
  open.push(c);
  return c;
}
async function setup(messages = 0): Promise<{ b: Browser; sid: string }> {
  const b = new Browser(env.gw.publicApp);
  await b.login();
  const sid = await b.newSession('en');
  for (let i = 0; i < messages; i++) await b.say(sid, `m${i + 1}`);
  return { b, sid };
}
const ids = (c: SseClient): number[] => c.evts().map((e) => e.id);
const ephEnvelope = (sid: string, fence: number, payload: Record<string, unknown>, type = 'agent.delta') => ({
  sessionId: sid,
  type,
  ts: new Date().toISOString(),
  traceId: 't',
  fence,
  payload,
});
const publishEph = (sid: string, event: unknown, channelSid = sid): Promise<number> =>
  env.harnessRedis.publish(`sse:session:${channelSid}`, JSON.stringify({ kind: 'eph', event }));

describe.skipIf(reason !== null)('SSE stream (acceptance 3)', () => {
  it('headers, retry, backlog after ?afterSeq, then the current status', async () => {
    const { b, sid } = await setup(3);
    const c = await stream(b, sid, { afterSeq: 1 });
    expect(c.status).toBe(200);
    await c.until(() => c.statuses().length > 0, 5000, 'status frame');
    expect(c.frames[0]).toEqual({ retry: String(SSE_RETRY_MS) });
    expect(ids(c)).toEqual([2, 3]);
    expect(c.statuses()).toEqual(['queued']);
    for (const e of c.evts()) expect(check(PublicEventSchema, e.data)).toBe(true);
  });

  it('live events follow the backlog in seq order; agent messages are the public view only', async () => {
    const { b, sid } = await setup(1);
    const c = await stream(b, sid);
    await c.until(() => c.statuses().length > 0);
    const h = new Harness(env.gw.internalApp);
    const fence = await env.harnessRedis.incr(`lease:fence:${sid}`);
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    await h.emit(sid, fence, reply(run, 1, 'Oslo to Lisboa is 2796.28 km'));
    await b.say(sid, 'thanks');
    await c.until(() => ids(c).length === 4, 5000, '4 events');
    expect(ids(c)).toEqual([1, 2, 3, 4]);
    const msg = c.evts()[2]!.data;
    expect(msg).toMatchObject({
      type: 'agent.message',
      payload: { runId: run, kind: 'reply', text: 'Oslo to Lisboa is 2796.28 km' },
    });
    expect(JSON.stringify(c.frames)).not.toMatch(/messageJson|profile|piVersion|inputSeqs/);
    await c.until(() => c.statuses().includes('running'), 5000, 'running status');
  });

  it('reconnect with Last-Event-ID resumes exactly after it: no gap, no duplicate (Last-Event-ID beats ?afterSeq)', async () => {
    const { b, sid } = await setup(2);
    const c1 = await stream(b, sid);
    await c1.until(() => ids(c1).length === 2);
    c1.close();
    await sleep(100);
    for (let i = 0; i < 3; i++) await b.say(sid, `while offline ${i}`); // seq 3..5 happen while disconnected
    const last = String(ids(c1).at(-1));
    const c2 = await stream(b, sid, { lastEventId: last, afterSeq: 0 });
    await c2.until(() => ids(c2).length === 3, 5000, 'resumed backlog');
    expect(ids(c2)).toEqual([3, 4, 5]);
    await b.say(sid, 'live again');
    await c2.until(() => ids(c2).length === 4, 5000, 'live after resume');
    expect(ids(c2)).toEqual([3, 4, 5, 6]);
    // resume from the very end: nothing replayed
    const c3 = await stream(b, sid, { lastEventId: '6' });
    await c3.until(() => c3.statuses().length > 0);
    expect(ids(c3)).toEqual([]);
  });

  it('no gap / duplicate when events race the backlog read (subscribe-before-query)', async () => {
    const { b, sid } = await setup(1);
    const writes = Promise.all(Array.from({ length: 15 }, (_, i) => b.say(sid, `burst ${i}`)));
    const c = await stream(b, sid);
    await writes;
    await c.until(() => ids(c).length === 16, 8000, '16 events');
    expect(ids(c)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('bad Last-Event-ID / afterSeq -> 400; someone else’s session -> 404; no cookie -> 401', async () => {
    const { b, sid } = await setup();
    const bad = await stream(b, sid, { lastEventId: 'abc' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(await bad.text()).error.code).toBe('VALIDATION_FAILED');
    const other = await setup();
    const nf = await stream(other.b, sid);
    expect(nf.status).toBe(404);
    expect(JSON.parse(await nf.text()).error.code).toBe('SESSION_NOT_FOUND');
    const anon = await SseClient.open(`${base}/api/v1/sessions/${sid}/stream`, {});
    open.push(anon);
    expect(anon.status).toBe(401);
  });
});

describe.skipIf(reason !== null)('SSE ephemeral events (§4.4 ①–④, M-4, M-17)', () => {
  it('forwards valid deltas / tool status as `eph` without fence; drops wrong schema, session, stale fence, > 4 KB', async () => {
    const { b, sid } = await setup(1);
    const other = await setup();
    const c = await stream(b, sid);
    await c.until(() => c.statuses().length > 0);
    const run = newRun();
    const fence = await env.harnessRedis.incr(`lease:fence:${sid}`);
    const dropped0 = { ...env.gw.sse.dropped };

    await publishEph(sid, ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', textDelta: 'Hel' }));
    await publishEph(
      sid,
      ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', textDelta: 'thinking' }, 'agent.reasoning_delta'),
    );
    await publishEph(
      sid,
      ephEnvelope(
        sid,
        fence,
        { runId: run, toolCallId: 'tc1', name: 'search_routes', phase: 'start' },
        'agent.tool_status',
      ),
    );
    await publishEph(sid, ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', reset: true }));
    await c.until(() => c.ephs().length === 4, 5000, '4 ephemerals');
    expect(c.ephs()).toEqual([
      { type: 'agent.delta', payload: { runId: run, messageKey: 'm1', textDelta: 'Hel' } },
      { type: 'agent.reasoning_delta', payload: { runId: run, messageKey: 'm1', textDelta: 'thinking' } },
      { type: 'agent.tool_status', payload: { runId: run, toolCallId: 'tc1', name: 'search_routes', phase: 'start' } },
      { type: 'agent.delta', payload: { runId: run, messageKey: 'm1', reset: true } },
    ]);
    for (const e of c.ephs()) expect(check(PublicEphemeralSchema, e)).toBe(true);
    for (const f of c.frames.filter((x) => x.event === 'eph')) expect(f.id).toBeUndefined(); // not resumable

    // ① schema: extra key, unknown type, missing fence
    await publishEph(sid, {
      ...ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', textDelta: 'x' }),
      userId: 'u',
    });
    await publishEph(sid, ephEnvelope(sid, fence, { status: 'running' }, 'agent.status'));
    const noFence: Record<string, unknown> = ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', textDelta: 'x' });
    delete noFence.fence;
    await publishEph(sid, noFence);
    await env.harnessRedis.publish(`sse:session:${sid}`, 'not json');
    // ② envelope for another session published on this session's channel (and vice versa)
    await publishEph(sid, ephEnvelope(other.sid, fence, { runId: run, messageKey: 'm1', textDelta: 'cross' }));
    // ④ size
    await publishEph(sid, ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', textDelta: 'x'.repeat(4200) }));
    // ③ fence: a new worker took over; after the 1 s fence cache the old worker's deltas are dropped
    const newer = await env.harnessRedis.incr(`lease:fence:${sid}`);
    await sleep(1100);
    await publishEph(sid, ephEnvelope(sid, fence, { runId: run, messageKey: 'm1', textDelta: 'stale worker' }));
    await publishEph(sid, ephEnvelope(sid, newer, { runId: run, messageKey: 'm2', textDelta: 'new worker' }));
    await c.until(() => c.ephs().length === 5, 5000, 'new worker delta');
    await sleep(300);
    expect(c.ephs()).toHaveLength(5);
    expect(c.ephs()[4]).toEqual({
      type: 'agent.delta',
      payload: { runId: run, messageKey: 'm2', textDelta: 'new worker' },
    });
    expect(JSON.stringify(c.frames)).not.toMatch(/cross|stale worker|"fence"|userId/);
    const d = env.gw.sse.dropped;
    expect(d.schema - dropped0.schema).toBe(3);
    expect(d.malformed - dropped0.malformed).toBe(1);
    expect(d.session - dropped0.session).toBe(1);
    expect(d.size - dropped0.size).toBe(1);
    expect(d.fence - dropped0.fence).toBe(1);
  });

  it('status frames follow the display status (queued -> running -> idle)', async () => {
    const { b, sid } = await setup(1);
    const c = await stream(b, sid);
    await c.until(() => c.statuses().length > 0);
    const h = new Harness(env.gw.internalApp);
    const fence = await env.harnessRedis.incr(`lease:fence:${sid}`);
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    await h.emit(sid, fence, {
      type: 'agent.run_completed',
      idempotencyKey: `run:${run}:done`,
      payload: {
        runId: run,
        endReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0 },
      },
    });
    await c.until(() => c.statuses().length >= 3, 5000, 'status changes');
    expect(c.statuses()).toEqual(['queued', 'running', 'idle']);
  });
});

describe.skipIf(reason !== null)('logout closes the SSE streams of that login only (S-4)', () => {
  it('ends every stream of the logged-out cookie; other logins of the same user keep streaming', async () => {
    const { b, sid } = await setup(1);
    const second = new Browser(env.gw.publicApp);
    await second.login(String((await b.get('/api/v1/me')).body.user.username));
    const mine1 = await stream(b, sid);
    const mine2 = await stream(b, sid);
    const theirs = await stream(second, sid);
    for (const c of [mine1, mine2, theirs]) await c.until(() => c.statuses().length > 0);
    expect((await b.raw('POST', '/api/v1/auth/logout')).status).toBe(204);
    await mine1.until(() => mine1.ended, 5000, 'stream 1 closed');
    await mine2.until(() => mine2.ended, 5000, 'stream 2 closed');
    await second.say(sid, 'still here');
    await theirs.until(() => ids(theirs).includes(2), 5000, 'other login still live');
    expect(theirs.ended).toBe(false);
  });

  it('a logout published by another gateway replica (sse:logout) closes the local stream', async () => {
    const { b, sid } = await setup(1);
    const c = await stream(b, sid);
    await c.until(() => c.statuses().length > 0);
    await env.admin.publish('sse:logout', JSON.stringify({ key: env.gw.ctx.auth.keyOf(b.sid) }));
    await c.until(() => c.ended, 5000, 'closed by broadcast');
  });
});

describe.skipIf(reason !== null)('Redis ACL', () => {
  it('no gateway command was refused during this file', async () => {
    expect(await env.aclDenials()).toEqual([]);
  });
});
