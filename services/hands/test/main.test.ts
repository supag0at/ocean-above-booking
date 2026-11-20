// Process wiring (main.ts): config -> secrets file -> pg pool as fb_hands -> token keys -> routes on a real
// listening socket. Guards against a server that listens without the execute route.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signHandsToken } from '@fb/contracts/server';
import type { FastifyInstance } from '@fb/platform/fastify';
import { startHands } from '../src/main.ts';
import { EXECUTE_PATH } from '../src/server.ts';
import { createFakeFlightCore } from './fakes/flight-core.ts';
import { fakeBuildProfile } from './fakes/memory.ts';
import { startTestDb, type TestDb } from './support/postgres.ts';

let db: TestDb;
let app: FastifyInstance;
let keyDir: string;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const dbPaths: string[] = [];

beforeAll(async () => {
  db = await startTestDb();
  keyDir = mkdtempSync(join(tmpdir(), 't08-hands-key-'));
  const pem = join(keyDir, 'hands_token_public_key.pem');
  writeFileSync(pem, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  app = await startHands({
    env: {
      HANDS_BIND: '127.0.0.1:0',
      HANDS_ALLOWED_PEERS: '127.0.0.1/32',
      PG_HOST: '127.0.0.1',
      PG_PORT: String(db.port),
      LOCATIONS_DB_PATH: '/data/locations.db',
      HANDS_VERIFY_KEY_PATHS: pem,
      LOG_LEVEL: 'silent',
    },
    secretsDir: db.secretsDir,
    createFlightCore: (o) => {
      dbPaths.push(o.dbPath);
      return createFakeFlightCore(o);
    },
    buildProfile: fakeBuildProfile,
  });
});
afterAll(async () => {
  await app?.close();
  await db?.stop();
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

describe('startHands', () => {
  it('passes { dbPath } from LOCATIONS_DB_PATH to the flight-core factory', () => {
    expect(dbPaths).toEqual(['/data/locations.db']);
  });

  it('serves POST /internal/execute on the bound address', async () => {
    const uid = randomUUID();
    const sid = randomUUID();
    await db.owner.query('INSERT INTO app.users (id, username, username_norm) VALUES ($1, $2, $2)', [uid, 'mainuser']);
    await db.owner.query('INSERT INTO app.sessions (id, user_id, locale, last_user_seq) VALUES ($1, $2, $3, $4)', [
      sid,
      uid,
      'en',
      1,
    ]);
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('not listening on TCP');
    const token = signHandsToken({ sid, uid, nowSec: Math.floor(Date.now() / 1000) }, privateKey);
    const res = await fetch(`http://127.0.0.1:${addr.port}${EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'quote_route',
        input: { from: 'Shanghai', to: 'Dubai' },
        toolCallId: 'call_main',
        runId: 'run_MAIN',
        inputSeq: 1,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { from: 'Shanghai', to: 'Dubai', priceCents: 65000 } });
    const ready = await fetch(`http://127.0.0.1:${addr.port}/readyz`);
    expect(ready.status).toBe(200);
  });
});
