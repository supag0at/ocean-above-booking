// Acceptance 2 (T08): identity comes only from the hands token (A-01 §5.3, H-04). Invalid tokens -> 401 HANDS_AUTH;
// user A's token never reaches user B's tickets, quotes or memories.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signHandsToken } from '@fb/contracts/server';
import type { ExecuteResponse } from '@fb/contracts/tools';
import type { Quote, TicketView } from '@fb/contracts/web';
import { NOW_SEC, startHarness, type Harness } from './support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const body = () => ({
  name: 'list_my_tickets',
  input: {},
  toolCallId: `call_${randomUUID()}`,
  runId: 'run_AUTH',
  inputSeq: 1,
});

describe('token validation', () => {
  it('rejects missing, malformed, foreign-key, expired and mismatched tokens with 401 HANDS_AUTH', async () => {
    const a = await h.newSession();
    const b = await h.newSession();
    const foreign = generateKeyPairSync('ed25519').privateKey;
    const bad: Record<string, string | undefined> = {
      missing: undefined,
      garbage: 'not.a.token',
      foreignKey: signHandsToken({ sid: a.sid, uid: a.uid, nowSec: NOW_SEC }, foreign),
      expired: h.token(a.sid, a.uid, NOW_SEC - 400),
      sidOfAUidOfB: h.token(a.sid, b.uid),
      unknownSession: h.token(randomUUID(), a.uid),
      nonUuidSid: h.token('not-a-uuid', a.uid),
    };
    for (const [label, tok] of Object.entries(bad)) {
      const r = await h.post(tok, body());
      expect({ label, status: r.status }).toEqual({ label, status: 401 });
      expect((r.json as { error: { code: string } }).error.code).toBe('HANDS_AUTH');
    }
    expect(await h.count('tool_calls', 'session_id = ANY($1::uuid[])', [[a.sid, b.sid]])).toBe(0);
    expect((await h.post(a.token, body())).status).toBe(200);
  });

  it('inputSeq beyond last_user_seq is a 400 VALIDATION_FAILED', async () => {
    const s = await h.newSession({ lastUserSeq: 2 });
    const r = await h.post(s.token, { ...body(), inputSeq: 3 });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('cross-user isolation', () => {
  it("A's token never sees B's tickets, quotes or memories", async () => {
    const a = await h.newSession();
    const b = await h.newSession();
    const qb = (await h.call(b, 'quote_route', { from: 'Shanghai', to: 'Dubai' })) as ExecuteResponse & { data: Quote };
    await h.issueTicket(qb.data, b.uid, b.sid);
    const qb2 = (await h.call(b, 'quote_route', { from: 'Shanghai', to: 'Tokyo' })) as ExecuteResponse & {
      data: Quote;
    };
    await h.call(b, 'save_preference', { key: 'home_city', value: 'Tokyo' });

    const list = (await h.call(a, 'list_my_tickets', {})) as ExecuteResponse & {
      data: { tickets: TicketView[]; total: number };
    };
    expect(list.data).toEqual({ tickets: [], total: 0 });
    const offer = await h.call(a, 'offer_booking', { quoteId: qb2.data.quoteId });
    expect(offer.ok === false && offer.error.code).toBe('QUOTE_NOT_FOUND');
    const snap = (await h.call(a, 'sys.profile_snapshot', {})) as ExecuteResponse & { data: Record<string, unknown> };
    expect(snap.data).toEqual({ frequentRoutes: [], ticketCount: 0 });

    // B still sees its own data (precondition: the negative results above are not vacuous)
    const bList = (await h.call(b, 'list_my_tickets', {})) as ExecuteResponse & { data: { total: number } };
    expect(bList.data.total).toBe(1);
    const bSnap = (await h.call(b, 'sys.profile_snapshot', {})) as ExecuteResponse & { data: Record<string, unknown> };
    expect(bSnap.data.homeCity).toEqual({ city: 'Tokyo', served: true });
  });

  it("writes are attributed to the token's user and session, never to tool arguments", async () => {
    const a = await h.newSession();
    const q = (await h.call(a, 'quote_route', { from: 'Shanghai', to: 'Dubai' })) as ExecuteResponse & { data: Quote };
    const row = await h.db.owner.query('SELECT user_id, session_id FROM app.quotes WHERE id = $1', [q.data.quoteId]);
    expect(row.rows[0]).toEqual({ user_id: a.uid, session_id: a.sid });
  });
});
