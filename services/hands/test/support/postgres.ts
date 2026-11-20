// Throw-away Postgres 16 for hands tests, provisioned exactly like production: infra/db/init/00-roles.sh creates
// the roles, runs the migrations and grants.sql (A-01 §3.3). Driven through the Docker Engine HTTP API over the
// local socket / named pipe (lint forbids child_process under services/). hands connects as fb_hands, fixtures
// are written as fb_owner (M-24 ⑥ allows ticket fixtures under services/*/test/**).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPgPool, type Pool } from '@fb/platform/pg';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const INFRA_DB = join(ROOT, 'infra', 'db');
const SOCKET = process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock';
const IMAGE = 'postgres:16';

function docker(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = text;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* plain text (logs) */
          }
          ok({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', fail);
    req.on('timeout', () => req.destroy(new Error('docker API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** True when a Docker daemon answers and the postgres:16 image is present locally (no pulls in tests). */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const ping = await docker('GET', '/_ping');
    if (ping.status !== 200) return false;
    const img = await docker('GET', `/images/${encodeURIComponent(IMAGE)}/json`);
    return img.status === 200;
  } catch {
    return false;
  }
}

export interface TestDb {
  readonly hands: Pool;
  readonly owner: Pool;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secret = (v: string) => ({ get: () => v });

export async function startTestDb(): Promise<TestDb> {
  const pw = {
    owner: randomBytes(12).toString('hex'),
    gateway: randomBytes(12).toString('hex'),
    hands: randomBytes(12).toString('hex'),
    booking: randomBytes(12).toString('hex'),
    superuser: randomBytes(12).toString('hex'),
  };
  const secretsDir = mkdtempSync(join(tmpdir(), 'fb-hands-pg-'));
  for (const [role, v] of Object.entries(pw)) writeFileSync(join(secretsDir, `pg_${role}_password`), `${v}\n`);

  const name = `fb-hands-test-${randomBytes(4).toString('hex')}`;
  const created = await docker('POST', `/containers/create?name=${name}`, {
    Image: IMAGE,
    Env: ['POSTGRES_DB=app', 'POSTGRES_PASSWORD_FILE=/run/secrets/pg_superuser_password', 'INFRA_DB_DIR=/infra-db'],
    ExposedPorts: { '5432/tcp': {} },
    HostConfig: {
      AutoRemove: false,
      Binds: [
        `${secretsDir}:/run/secrets:ro`,
        `${INFRA_DB}:/infra-db:ro`,
        `${join(INFRA_DB, 'init', '00-roles.sh')}:/docker-entrypoint-initdb.d/00-roles.sh:ro`,
      ],
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    },
  });
  if (created.status !== 201) throw new Error(`docker create failed: ${JSON.stringify(created.json)}`);
  const id = (created.json as { Id: string }).Id;
  const remove = async () => {
    await docker('DELETE', `/containers/${id}?force=true&v=true`).catch(() => undefined);
    rmSync(secretsDir, { recursive: true, force: true });
  };
  try {
    const started = await docker('POST', `/containers/${id}/start`);
    if (started.status !== 204) throw new Error(`docker start failed: ${JSON.stringify(started.json)}`);
    const info = await docker('GET', `/containers/${id}/json`);
    const port = Number(
      (info.json as { NetworkSettings: { Ports: Record<string, { HostPort: string }[]> } }).NetworkSettings.Ports[
        '5432/tcp'
      ]?.[0]?.HostPort,
    );
    const pool = (user: string, password: string) =>
      createPgPool({
        host: '127.0.0.1',
        port,
        database: 'app',
        user,
        secrets: secret(password),
        max: 12,
        statementTimeoutMs: 15_000,
        connectionTimeoutMs: 3_000,
      });

    // The init phase only listens on the unix socket; a TCP login as fb_hands that sees app.tool_calls means
    // 00-roles.sh finished (roles, migrations, grants) and the final server is up.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const probe = pool('fb_hands', pw.hands);
      try {
        await probe.query('SELECT 1 FROM app.tool_calls LIMIT 1');
        await probe.end();
        break;
      } catch (err) {
        await probe.end().catch(() => undefined);
        if (Date.now() > deadline) {
          const logs = await docker('GET', `/containers/${id}/logs?stdout=true&stderr=true`);
          throw new Error(`postgres not ready: ${String(err)}\n${String(logs.json).slice(-2000)}`);
        }
        await sleep(500);
      }
    }
    const hands = pool('fb_hands', pw.hands);
    const owner = pool('fb_owner', pw.owner);
    return {
      hands,
      owner,
      async stop() {
        await Promise.allSettled([hands.end(), owner.end()]);
        await remove();
      },
    };
  } catch (err) {
    await remove();
    throw err;
  }
}
