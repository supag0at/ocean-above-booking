// Acceptance 4: the 7 emit steps of A-01 §5.1, one counter-example each (plus the positive path), the session API's
// auth / peer check / reads, hands-token issuance (§5.3, signed with the M-24 contract implementation) and the
// "concurrent writes of one session are serialised" row of §11.
import { randomUUID } from 'node:crypto';
import { MAX_EMIT_BODY_BYTES, handsTokenKid, verifyHandsToken } from '@fb/contracts/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, Harness, type Res } from './helpers/client.ts';
import { HARNESS_TOKEN, seedQuote, skipReason, startEnv, type Env } from './helpers/env.ts';
import { newRun, offered, reply, runCompleted, runFailed, runStarted } from './helpers/fixtures.ts';

const reason = await skipReason();
if (reason) console.warn(`[gateway session-api tests skipped] ${reason}`);
let env: Env;
beforeAll(async () => {
  if (!reason) env = await startEnv();
}, 180_000);
afterAll(async () => {
  await env?.close();
});

const I = '/internal/v1/sessions';
function expectErr(r: Res, status: number, code: string): void {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error.code, JSON.stringify(r.body)).toBe(code);
}

interface Ctx {
  b: Browser;
  h: Harness;
  sid: string;
  fence: number;
}
/** A user session with `messages` user.messages and a harness holding the current fence. */
async function setup(messages = 1): Promise<Ctx> {
  const b = new Browser(env.gw.publicApp);
  await b.login();
  const sid = await b.newSession('en');
  for (let i = 0; i < messages; i++) expect((await b.say(sid, `msg ${i}`)).status).toBe(202);
  const fence = await env.harnessRedis.incr(`lease:fence:${sid}`);
  return { b, h: new Harness(env.gw.internalApp), sid, fence };
}
async function sessionRow(sid: string): Promise<Record<string, unknown>> {
  const { rows } = await env.owner.query('SELECT * FROM app.sessions WHERE id = $1', [sid]);
  return rows[0] as Record<string, unknown>;
}
async function eventCount(sid: string): Promise<number> {
  const { rows } = await env.owner.query('SELECT count(*)::int AS n FROM app.events WHERE session_id = $1', [sid]);
  return (rows[0] as { n: number }).n;
}
const toolCallsMsg = (runId: string, n: number) => ({
  type: 'agent.message',
  idempotencyKey: `msg:m:${runId}:1:${n}`,
  payload: {
    runId,
    attempt: 1,
    n,
    messageKey: `m:${runId}:1:${n}`,
    messageJson: '{"role":"assistant"}',
    piVersion: '1.5.2',
    role: 'assistant',
    hasToolCalls: true,
    viewText: '',
    processText: 'looking up routes',
  },
});

describe.skipIf(reason !== null)('session API: auth, peer, reads', () => {
  it('401 SERVICE_AUTH_INVALID without / with a wrong / with a prefixed bearer token', async () => {
    const { h, sid } = await setup();
    for (const token of ['', 'x', `${HARNESS_TOKEN}x`, HARNESS_TOKEN.slice(1)]) {
      h.token = token;
      expectErr(await h.req('GET', `${I}/${sid}`), 401, 'SERVICE_AUTH_INVALID');
    }
    const r = await env.gw.internalApp.inject({
      method: 'GET',
      url: `${I}/${sid}`,
      headers: { authorization: HARNESS_TOKEN },
    });
    expect(r.statusCode).toBe(401);
  });

  it('403 FORBIDDEN_PEER from outside the harness range (checked before auth)', async () => {
    const { sid } = await setup();
    const r = await env.gw.internalApp.inject({
      method: 'GET',
      url: `${I}/${sid}`,
      remoteAddress: '10.9.9.9',
      headers: { authorization: `Bearer ${HARNESS_TOKEN}` },
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error.code).toBe('FORBIDDEN_PEER');
  });

  it('GET session: { id, locale, lastSeq } and never userId; 404 unknown; 400 malformed id', async () => {
    const { h, sid } = await setup(2);
    const r = await h.req('GET', `${I}/${sid}`);
    expect(r.body).toEqual({ id: sid, locale: 'en', lastSeq: 2 });
    expectErr(await h.req('GET', `${I}/${randomUUID()}`), 404, 'SESSION_NOT_FOUND');
    expectErr(await h.req('GET', `${I}/nope`), 400, 'VALIDATION_FAILED');
  });

  it('GET events: full internal envelopes in seq order, afterSeq / limit / hasMore, limit <= 500', async () => {
    const { h, sid, fence } = await setup(3);
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1, 2, 3]));
    await h.emit(sid, fence, reply(run, 1, 'done'));
    const r = await h.req('GET', `${I}/${sid}/events?afterSeq=1&limit=3`);
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: { seq: number }) => e.seq)).toEqual([2, 3, 4]);
    expect(r.body.hasMore).toBe(true);
    const last = (await h.req('GET', `${I}/${sid}/events?afterSeq=4`)).body.events[0];
    expect(last).toMatchObject({ seq: 5, type: 'agent.message', actor: 'agent', schemaVersion: 1, sessionId: sid });
    expect(last.payload.messageJson).toBeTypeOf('string'); // internal view keeps it; public never does
    expectErr(await h.req('GET', `${I}/${sid}/events?limit=501`), 400, 'VALIDATION_FAILED');
    expectErr(await h.req('GET', `${I}/${randomUUID()}/events`), 404, 'SESSION_NOT_FOUND');
  });
});

describe.skipIf(reason !== null)('emitEvent: the 7 steps (A-01 §5.1), one counter-example each', () => {
  it('positive path: 201 {seq,id}; actor from the call source; tracking columns + max_fence_seen updated', async () => {
    const { h, sid, fence } = await setup(2);
    const run = newRun();
    const r = await h.emit(sid, fence, runStarted(run, [1, 2]));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ seq: 3, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const s = await sessionRow(sid);
    expect(s).toMatchObject({
      last_seq: '3',
      consumed_up_to_seq: '2',
      open_run_id: run,
      oldest_unconsumed_at: null,
      max_fence_seen: String(fence),
      status: 'running',
    });
    expect(s.last_agent_event_at).not.toBeNull();
    const { rows } = await env.owner.query('SELECT actor FROM app.events WHERE session_id = $1 AND seq = 3', [sid]);
    expect((rows[0] as { actor: string }).actor).toBe('agent');
  });

  it('step 1a size: > 64 KB raw body -> 400 EVENT_INVALID, nothing written', async () => {
    const { h, sid, fence } = await setup();
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    const sized = (n: number, bytes: number) => {
      const ev = reply(run, n, '');
      const shell = JSON.stringify({ ...ev, payload: { ...ev.payload, viewText: '' } });
      return { ...ev, payload: { ...ev.payload, viewText: 'x'.repeat(bytes - Buffer.byteLength(shell)) } };
    };
    expect(Buffer.byteLength(JSON.stringify(sized(1, MAX_EMIT_BODY_BYTES + 1)))).toBe(MAX_EMIT_BODY_BYTES + 1);
    expectErr(await h.emit(sid, fence, sized(1, MAX_EMIT_BODY_BYTES + 1)), 400, 'EVENT_INVALID');
    // multi-byte characters count as bytes, not characters
    const cjk = reply(run, 1, '价'.repeat(11_000)); // 11 000 chars, 2 × 33 000 bytes (viewText + messageJson)
    expect(JSON.stringify(cjk).length).toBeLessThan(MAX_EMIT_BODY_BYTES);
    expectErr(await h.emit(sid, fence, cjk), 400, 'EVENT_INVALID');
    // exactly 64 KB is accepted
    expect((await h.emit(sid, fence, sized(2, MAX_EMIT_BODY_BYTES))).status).toBe(201);
    // far above (> 2 × 64 KB) the transport limit answers first: 413 PAYLOAD_TOO_LARGE (reported to the parent)
    expectErr(await h.emit(sid, fence, sized(3, 3 * MAX_EMIT_BODY_BYTES)), 413, 'PAYLOAD_TOO_LARGE');
    expect(await eventCount(sid)).toBe(3);
  });

  it('step 1b schema: missing / extra / mistyped fields and M-16 violations -> 400 EVENT_INVALID', async () => {
    const { h, sid, fence } = await setup();
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    const base = toolCallsMsg(run, 1);
    const bad: unknown[] = [
      { ...base, payload: { ...base.payload, viewText: 'leak' } }, // M-16: tool-call message must have viewText ''
      { ...base, payload: { ...base.payload, processText: undefined } },
      { ...base, payload: { ...base.payload, userId: randomUUID() } },
      { ...base, payload: { ...base.payload, attempt: '1' } },
      { ...base, payload: { ...base.payload, attempt: 1.5 } },
      { ...base, extra: 1 },
      { type: 'agent.message', payload: base.payload }, // no idempotencyKey
      { ...runCompleted(run), payload: { runId: 'not-a-run' } },
    ];
    for (const ev of bad)
      expectErr(await h.req('POST', `${I}/${sid}/events`, { fence, body: ev }), 400, 'EVENT_INVALID');
    expectErr(await h.req('POST', `${I}/${sid}/events`, { fence, raw: '[]' }), 400, 'EVENT_INVALID');
    expect(await eventCount(sid)).toBe(2);
  });

  it('step 1 consistency: run_started consumedUpToSeq / inputSeqs rules -> 400 EVENT_INVALID', async () => {
    const { h, sid, fence } = await setup(2);
    const run0 = newRun();
    await h.emit(sid, fence, { ...reply(run0, 1, 'x'), idempotencyKey: 'pre' }); // seq 3 is an agent.message
    const run = newRun();
    for (const ev of [
      runStarted(run, [1, 2], 1), // consumedUpToSeq != max(inputSeqs)
      runStarted(run, [1, 2, 4], 4), // beyond last_user_seq
      runStarted(run, [1, 3], 3), // seq 3 is not a user.message
      runStarted(run, [2, 2], 2), // duplicates
    ]) {
      expectErr(await h.emit(sid, fence, ev), 400, 'EVENT_INVALID');
    }
    expect((await sessionRow(sid)).consumed_up_to_seq).toBe('0');
  });

  it('step 2 lock: unknown session -> 404; 30 concurrent emits get gap-free, unique seqs (§11)', async () => {
    const { h, sid, fence } = await setup();
    expectErr(await h.emit(randomUUID(), fence, runStarted(newRun(), [1])), 404, 'SESSION_NOT_FOUND');
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => h.emit(sid, fence, toolCallsMsg(run, i + 1))));
    expect(rs.map((r) => r.status)).toEqual(Array(30).fill(201));
    const seqs = rs.map((r) => r.body.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 3));
    expect((await sessionRow(sid)).last_seq).toBe('32');
  });

  it('step 3 whitelist: user.*, booking.*, ephemeral and unknown types -> 403 EVENT_TYPE_FORBIDDEN', async () => {
    const { h, sid, fence } = await setup();
    const qid = await seedQuote(env.owner, {
      userId: (await sessionRow(sid)).user_id as string,
      sessionId: sid,
      offered: true,
    });
    const tid = 't_0123456789ABCDEFGHJKMNPQRS';
    for (const ev of [
      { type: 'user.message', payload: { text: 'forged', clientMessageId: randomUUID() }, idempotencyKey: 'u' },
      {
        type: 'booking.confirmed',
        payload: { quoteId: qid, ticketId: tid, ticketNo: 'OA-x', summary: {} },
        idempotencyKey: `booking:${qid}`,
      },
      { type: 'booking.failed', payload: { quoteId: qid, code: 'QUOTE_NOT_OFFERED' }, idempotencyKey: 'bf' },
      { type: 'agent.delta', payload: { runId: newRun(), messageKey: 'm', textDelta: 'x' }, idempotencyKey: 'd' },
      { type: 'session.created', payload: {}, idempotencyKey: 's' },
      { type: '__proto__', payload: {}, idempotencyKey: 'p' },
    ]) {
      expectErr(await h.emit(sid, fence, ev), 403, 'EVENT_TYPE_FORBIDDEN');
    }
    expect(await eventCount(sid)).toBe(1);
  });

  it('step 4 fence: stale -> 409 FENCE_STALE (nothing written); bad header -> 400; every type is fenced', async () => {
    const { h, sid, fence } = await setup();
    const run = newRun();
    expect((await h.emit(sid, fence, runStarted(run, [1]))).status).toBe(201);
    const newer = await env.harnessRedis.incr(`lease:fence:${sid}`); // a new worker took the lease
    expectErr(await h.emit(sid, fence, reply(run, 1, 'from the old worker')), 409, 'FENCE_STALE');
    expectErr(
      await h.emit(sid, fence, {
        type: 'agent.context_compacted',
        idempotencyKey: 'compact:x',
        payload: {
          compactionId: 'cmp_x',
          boundaryRunId: run,
          summaryText: 's',
          summaryVersion: 1,
          estBefore: 2,
          estAfter: 1,
        },
      }),
      409,
      'FENCE_STALE',
    );
    expectErr(await h.req('POST', `${I}/${sid}/hands-token`, { fence }), 409, 'FENCE_STALE');
    expect(await eventCount(sid)).toBe(2);
    expect((await h.emit(sid, newer, reply(run, 1, 'from the new worker'))).status).toBe(201);
    for (const f of [undefined, '', '-1', '1.5', 'abc']) {
      expectErr(
        await h.req('POST', `${I}/${sid}/events`, { fence: f as never, body: reply(run, 2, 'x') }),
        400,
        'VALIDATION_FAILED',
      );
    }
  });

  it('step 4 fence after Redis data loss: old fence -> 409 + fence raised to max_fence_seen+1; new worker writes (§11)', async () => {
    const { h, sid } = await setup();
    await env.harnessRedis.set(`lease:fence:${sid}`, '57');
    const run = newRun();
    expect((await h.emit(sid, 57, runStarted(run, [1]))).status).toBe(201);
    expect((await sessionRow(sid)).max_fence_seen).toBe('57');
    await env.admin.del(`lease:fence:${sid}`); // Redis lost the key
    expectErr(await h.emit(sid, 57, reply(run, 1, 'old worker')), 409, 'FENCE_STALE');
    expect(await env.admin.get(`lease:fence:${sid}`)).toBe('58');
    expectErr(await h.emit(sid, 57, reply(run, 1, 'old worker again')), 409, 'FENCE_STALE');
    const next = await env.harnessRedis.incr(`lease:fence:${sid}`);
    expect(next).toBe(59);
    expect((await h.emit(sid, next, reply(run, 1, 'new worker'))).status).toBe(201);
    expect(env.logLines.some((l) => l.includes('Redis lost data, fence raised'))).toBe(true);
  });

  it('step 5 quote.offered: needs a quote_offers row (quote_id, tool_call_id) of THIS session -> else 400', async () => {
    const { h, sid, fence } = await setup();
    const uid = (await sessionRow(sid)).user_id as string;
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    const other = await setup();
    const unoffered = await seedQuote(env.owner, { userId: uid, sessionId: sid, offered: false });
    const offeredElsewhere = await seedQuote(env.owner, {
      userId: uid,
      sessionId: other.sid,
      offered: true,
      toolCallId: 'tcX',
    });
    const mine = await seedQuote(env.owner, { userId: uid, sessionId: sid, offered: true, toolCallId: 'tc1' });
    expectErr(await h.emit(sid, fence, offered(run, unoffered, 'tc1')), 400, 'EVENT_INVALID');
    expectErr(await h.emit(sid, fence, offered(run, offeredElsewhere, 'tcX')), 400, 'EVENT_INVALID');
    expectErr(await h.emit(sid, fence, offered(run, mine, 'tc-wrong')), 400, 'EVENT_INVALID');
    const extra = offered(run, mine, 'tc1');
    expectErr(
      await h.emit(sid, fence, { ...extra, payload: { ...extra.payload, priceCents: 1 } }),
      400,
      'EVENT_INVALID',
    );
    expect((await h.emit(sid, fence, offered(run, mine, 'tc1'))).status).toBe(201);
  });

  it('step 6 idempotency: replay -> 200 deduplicated (key order irrelevant); other content -> 409 IDEMPOTENCY_CONFLICT', async () => {
    const { h, sid, fence } = await setup();
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    const ev = reply(run, 1, 'hello');
    const first = await h.emit(sid, fence, ev);
    expect(first.status).toBe(201);
    const reordered = {
      idempotencyKey: ev.idempotencyKey,
      payload: Object.fromEntries(Object.entries(ev.payload).reverse()),
      type: ev.type,
    };
    const again = await h.emit(sid, fence, reordered);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ seq: first.body.seq, id: first.body.id, deduplicated: true });
    expectErr(await h.emit(sid, fence, reply(run, 1, 'different')), 409, 'IDEMPOTENCY_CONFLICT');
    expectErr(
      await h.emit(sid, fence, { ...runFailed(run), idempotencyKey: ev.idempotencyKey }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    // 10 concurrent replays of a fresh key: exactly one row
    const ev2 = reply(run, 2, 'once');
    const rs = await Promise.all(Array.from({ length: 10 }, () => h.emit(sid, fence, ev2)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200 && r.body.deduplicated === true)).toHaveLength(9);
    expect(new Set(rs.map((r) => r.body.seq)).size).toBe(1);
    expect(await eventCount(sid)).toBe(4);
  });

  it('step 7 write: seq = last_seq + 1 and the §6.4 tracking table (resumed / completed / failed / compacted)', async () => {
    const { b, h, sid, fence } = await setup(1);
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    await b.say(sid, 'mid-run'); // seq 3, arrives while the run is open
    let s = await sessionRow(sid);
    expect(s).toMatchObject({ last_user_seq: '3', consumed_up_to_seq: '1', open_run_id: run, status: 'running' });
    expect(s.oldest_unconsumed_at).not.toBeNull();
    const resumed = await h.emit(sid, fence, {
      type: 'agent.run_resumed',
      idempotencyKey: `run:${run}:resumed:2`,
      payload: { runId: run, attempt: 2 },
    });
    expect(resumed.body.seq).toBe(4);
    await h.emit(sid, fence, {
      type: 'agent.context_compacted',
      idempotencyKey: 'compact:cmp_1',
      payload: {
        compactionId: 'cmp_1',
        boundaryRunId: run,
        summaryText: 's',
        summaryVersion: 1,
        estBefore: 2,
        estAfter: 1,
      },
    });
    expect((await sessionRow(sid)).consumed_up_to_seq).toBe('1'); // compaction consumes nothing
    await h.emit(sid, fence, runCompleted(run));
    s = await sessionRow(sid);
    expect(s).toMatchObject({ open_run_id: null, last_run_outcome: 'completed', status: 'queued', last_seq: '6' });
    const run2 = newRun();
    await h.emit(sid, fence, runStarted(run2, [3]));
    s = await sessionRow(sid);
    expect(s).toMatchObject({ consumed_up_to_seq: '3', oldest_unconsumed_at: null, status: 'running' });
    await h.emit(sid, fence, runFailed(run2));
    expect(await sessionRow(sid)).toMatchObject({ open_run_id: null, last_run_outcome: 'failed', status: 'error' });
  });
});

describe.skipIf(reason !== null)('hands token (A-01 §5.3, M-24 contract implementation)', () => {
  it('200 { token, expiresAt }: EdDSA JWS verifiable with @fb/contracts verifyHandsToken, sid/uid of the session', async () => {
    const { h, sid, fence } = await setup();
    const r = await h.req('POST', `${I}/${sid}/hands-token`, { fence });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    const v = verifyHandsToken(r.body.token, new Map([[handsTokenKid(env.publicKey), env.publicKey]]), now);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.claims).toMatchObject({ iss: 'gateway', aud: 'hands', sid, uid: (await sessionRow(sid)).user_id });
    expect(v.claims.exp - v.claims.iat).toBe(300);
    expect(Date.parse(r.body.expiresAt) / 1000).toBe(v.claims.exp);
    const r2 = await h.req('POST', `${I}/${sid}/hands-token`, { fence });
    expect(r2.body.token).not.toBe(r.body.token); // fresh jti
  });

  it('409 SESSION_INACTIVE with no unconsumed input and no open run; allowed again while a run is open', async () => {
    const { h, sid, fence } = await setup();
    const run = newRun();
    await h.emit(sid, fence, runStarted(run, [1]));
    expect((await h.req('POST', `${I}/${sid}/hands-token`, { fence })).status).toBe(200); // open run
    await h.emit(sid, fence, runCompleted(run));
    expectErr(await h.req('POST', `${I}/${sid}/hands-token`, { fence }), 409, 'SESSION_INACTIVE');
    expectErr(await h.req('POST', `${I}/${randomUUID()}/hands-token`, { fence }), 404, 'SESSION_NOT_FOUND');
    expectErr(await h.req('POST', `${I}/${sid}/hands-token`, {}), 400, 'VALIDATION_FAILED');
  });
});

describe.skipIf(reason !== null)('Redis ACL', () => {
  it('no gateway command was refused during this file', async () => {
    expect(await env.aclDenials()).toEqual([]);
  });
});
