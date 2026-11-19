// T07 acceptance demo for a human reviewer: `node services/booking/scripts/demo.ts`
//
// Starts a throw-away Postgres 16 (infra/db/init/00-roles.sh: real roles, migrations and grants), seeds fixture rows
// as fb_owner (what hands would have written), runs the real booking HTTP server on 127.0.0.1 as role fb_booking,
// and walks through: normal booking, repeated booking, 20 concurrent confirms of one quote, every error path.
// Exit code 0 only if every expectation holds. The container is removed at the end (also on failure).
import { randomBytes } from 'node:crypto';
import { newQuoteId } from '@fb/contracts/server';
import type { FastifyInstance } from '@fb/platform/fastify';
import type { Pool } from '@fb/platform/pg';
import { buildBookingApp, BOOKINGS_PATH } from '../src/server.ts';
import { createQuote, createUser } from '../test/support/fixtures.ts';
import { dockerSocket, startPgContainer, type PgContainer } from '../test/support/pg-container.ts';

const results: { ok: boolean; label: string }[] = [];
function expect(ok: boolean, label: string, detail = ''): void {
  results.push({ ok, label });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
const section = (title: string) => console.log(`\n== ${title}`);

interface Reply {
  status: number;
  body: {
    ticket?: { ticketId: string; ticketNo: string; priceCents: number };
    alreadyBooked?: boolean;
    error?: { code: string };
  };
}

async function main(): Promise<number> {
  if ((await dockerSocket()) === null) {
    console.error('docker daemon not reachable: start Docker Desktop first');
    return 2;
  }
  console.log('starting postgres:16 (roles + migrations + grants via infra/db/init/00-roles.sh) ...');
  let pg: PgContainer | undefined;
  const pools: Pool[] = [];
  const apps: FastifyInstance[] = [];
  try {
    pg = await startPgContainer('fb-t07-demo');
    const owner = pg.pool('fb_owner');
    const booking = pg.pool('fb_booking', 25);
    pools.push(owner, booking);
    const token = `demo-${randomBytes(16).toString('hex')}`;

    const app = await buildBookingApp({
      pool: booking,
      serviceToken: token,
      allowedPeers: ['127.0.0.1/32', '::1/128'],
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no listen address');
    const url = `http://127.0.0.1:${addr.port}${BOOKINGS_PATH}`;
    console.log(`booking listening on ${url} (db role fb_booking)`);

    const post = async (body: unknown, auth: string | null = `Bearer ${token}`): Promise<Reply> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth !== null) headers.authorization = auth;
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Reply['body'] };
    };
    const count = async (quoteId: string) =>
      Number(
        (await owner.query<{ n: string }>('SELECT count(*)::text n FROM app.tickets WHERE quote_id = $1', [quoteId]))
          .rows[0]?.n,
      );
    const req = (quoteId: string, userId: string) => ({
      quoteId,
      userId,
      requestId: `demo-${randomBytes(4).toString('hex')}`,
    });

    const ann = await createUser(owner, 'Ann');
    const bob = await createUser(owner, 'Bob');

    section('1. normal booking');
    const q1 = await createQuote(owner, ann);
    const first = await post(req(q1.quoteId, ann.userId));
    expect(first.status === 201, '201 Created', `ticketNo=${first.body.ticket?.ticketNo}`);
    expect(
      first.body.ticket?.priceCents === q1.payload.priceCents,
      'price copied from quote (not recomputed)',
      `${first.body.ticket?.priceCents} cents`,
    );

    section('2. repeated booking of the same quote');
    const again = await post(req(q1.quoteId, ann.userId));
    expect(again.status === 200 && again.body.alreadyBooked === true, '200 alreadyBooked');
    expect(
      again.body.ticket?.ticketId === first.body.ticket?.ticketId,
      'returns the FIRST ticket',
      again.body.ticket?.ticketId,
    );
    expect((await count(q1.quoteId)) === 1, 'tickets rows for this quote = 1');

    section('3. 20 concurrent confirms of one quote');
    const q2 = await createQuote(owner, ann);
    const replies = await Promise.all(Array.from({ length: 20 }, () => post(req(q2.quoteId, ann.userId))));
    const created = replies.filter((r) => r.status === 201).length;
    const already = replies.filter((r) => r.status === 200 && r.body.alreadyBooked === true).length;
    const ids = new Set(replies.map((r) => r.body.ticket?.ticketId));
    expect(
      created === 1 && already === 19,
      'exactly one 201, nineteen 200 alreadyBooked',
      `201×${created}, 200×${already}`,
    );
    expect(ids.size === 1, 'all 20 replies carry the same ticket', [...ids].join(','));
    expect((await count(q2.quoteId)) === 1, 'tickets rows for this quote = 1');

    section('4. rejections (nothing written)');
    const r404other = await post(req(q1.quoteId, bob.userId));
    expect(
      r404other.status === 404 && r404other.body.error?.code === 'QUOTE_NOT_FOUND',
      "someone else's quote → 404 QUOTE_NOT_FOUND",
    );
    const unoffered = await createQuote(owner, ann, { offered: false });
    const r409 = await post(req(unoffered.quoteId, ann.userId));
    expect(
      r409.status === 409 && r409.body.error?.code === 'QUOTE_NOT_OFFERED',
      'never-offered quote → 409 QUOTE_NOT_OFFERED',
    );
    expect((await count(unoffered.quoteId)) === 0, 'no ticket for the never-offered quote');
    const r404none = await post(req(newQuoteId(), ann.userId));
    expect(
      r404none.status === 404 && r404none.body.error?.code === 'QUOTE_NOT_FOUND',
      'non-existent quote → 404 QUOTE_NOT_FOUND',
    );
    const used = await post(req(q2.quoteId, ann.userId));
    expect(
      used.status === 200 && used.body.alreadyBooked === true,
      'already-used quote → 200 alreadyBooked (A-01 §5.4: idempotent, no error)',
    );
    const extra = await post({ ...req(q1.quoteId, ann.userId), sessionId: ann.sessionId });
    expect(
      extra.status === 400 && extra.body.error?.code === 'VALIDATION_FAILED',
      'extra body field → 400 VALIDATION_FAILED',
    );

    section('5. service auth and peer check');
    const q3 = await createQuote(owner, ann);
    const noTok = await post(req(q3.quoteId, ann.userId), null);
    expect(
      noTok.status === 401 && noTok.body.error?.code === 'SERVICE_AUTH_INVALID',
      'no token → 401 SERVICE_AUTH_INVALID',
    );
    const badTok = await post(req(q3.quoteId, ann.userId), 'Bearer not-the-token');
    expect(
      badTok.status === 401 && badTok.body.error?.code === 'SERVICE_AUTH_INVALID',
      'wrong token → 401 SERVICE_AUTH_INVALID',
    );
    const gwOnly = await buildBookingApp({ pool: booking, serviceToken: token, allowedPeers: ['172.30.3.20/32'] });
    apps.push(gwOnly);
    await gwOnly.listen({ host: '127.0.0.1', port: 0 });
    const gwAddr = gwOnly.server.address();
    if (gwAddr === null || typeof gwAddr === 'string') throw new Error('no listen address');
    const peer = await fetch(`http://127.0.0.1:${gwAddr.port}${BOOKINGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(req(q3.quoteId, ann.userId)),
    });
    const peerBody = (await peer.json()) as Reply['body'];
    expect(
      peer.status === 403 && peerBody.error?.code === 'FORBIDDEN_PEER',
      'peer 127.0.0.1 not in allow-list (gateway 172.30.3.20/32 only) → 403 FORBIDDEN_PEER, even with a valid token',
    );
    expect((await count(q3.quoteId)) === 0, 'no ticket written by any rejected request');

    section('6. database state (as fb_owner)');
    const rows = await owner.query<{
      ticket_no: string;
      quote_id: string;
      from_city: string;
      to_city: string;
      price_cents: number;
    }>('SELECT ticket_no, quote_id, from_city, to_city, price_cents FROM app.tickets ORDER BY booked_at');
    console.table(rows.rows);
    expect(rows.rowCount === 2, 'exactly 2 tickets in total (sections 1 and 3)');
    const events = await owner.query<{ n: string }>('SELECT count(*)::text n FROM app.events');
    expect(events.rows[0]?.n === '0', 'booking wrote no events (M-21: gateway writes booking.*)');
  } finally {
    for (const a of apps) await a.close();
    for (const p of pools) await p.end();
    await pg?.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
