// Throw-away Postgres 16 for booking tests and the acceptance demo. Same initialisation as production and CT-06:
// infra/db/init/00-roles.sh creates the four roles, runs the migrations and grants.sql.
//
// Talks to the Docker Engine HTTP API over its socket / named pipe with node:http, because child_process is
// forbidden under services/ (A-01 §1.2: depcruise no-child-process-vm + ESLint). Test / demo code only.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPgPool, type Pool } from '@fb/platform/pg';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const INFRA_DB = join(ROOT, 'infra', 'db');
export const PG_IMAGE = 'postgres:16';

export const ROLES = ['fb_owner', 'fb_gateway', 'fb_hands', 'fb_booking'] as const;
export type Role = (typeof ROLES)[number];

interface DockerResponse {
  status: number;
  body: Buffer;
}

function socketCandidates(): string[] {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith('npipe://')) return [host.slice('npipe://'.length)];
  if (host?.startsWith('unix://')) return [host.slice('unix://'.length)];
  if (host !== undefined && host !== '') return []; // tcp:// etc. not supported here
  return process.platform === 'win32'
    ? ['//./pipe/dockerDesktopLinuxEngine', '//./pipe/docker_engine']
    : ['/var/run/docker.sock', join(process.env.HOME ?? '', '.docker', 'run', 'docker.sock')];
}

function call(socketPath: string, method: string, path: string, body?: unknown, timeoutMs = 30_000) {
  return new Promise<DockerResponse>((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path}: timeout`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let socket: string | null | undefined;

/**
 * The Docker socket that answers /_ping, or null when no daemon is reachable (tests then skip, like CT-06).
 * Docker Desktop's resource saver can take several seconds to wake the engine on the first request (a 3 s probe
 * timed out and silently skipped the whole suite), so each candidate gets a few generous attempts. A missing
 * socket / pipe (ENOENT) is skipped at once. Skipping is announced loudly: a skip must never look like a pass.
 */
export async function dockerSocket(): Promise<string | null> {
  if (socket !== undefined) return socket;
  socket = null;
  outer: for (const candidate of socketCandidates()) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await call(candidate, 'GET', '/_ping', undefined, 10_000);
        if (r.status === 200) {
          socket = candidate;
          break outer;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break; // no such socket / pipe: next candidate
      }
      await sleep(1000);
    }
  }
  if (socket === null) console.warn('[T07] SKIPPED: docker daemon is not reachable; booking DB tests did NOT run');
  return socket;
}

async function docker(method: string, path: string, body?: unknown): Promise<DockerResponse> {
  const s = await dockerSocket();
  if (s === null) throw new Error('docker daemon not reachable');
  return call(s, method, path, body);
}

function expectStatus(r: DockerResponse, ok: number[], what: string): void {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 500)}`);
}

/** Non-TTY container logs are multiplexed: 8-byte header (stream, 0, 0, 0, size u32 BE) + payload. */
function demux(buf: Buffer): string {
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PgContainer {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** a pool for `role`, authenticating with that role's password over TCP (scram) */
  pool(role: Role, max?: number): Pool;
  logs(): Promise<string>;
  stop(): Promise<void>;
}

export async function startPgContainer(label = 'fb-t07'): Promise<PgContainer> {
  const name = `${label}-${randomBytes(4).toString('hex')}`;
  const secretsDir = mkdtempSync(join(tmpdir(), `${label}-secrets-`));
  const passwords = Object.fromEntries(ROLES.map((r) => [r, `pw-${randomBytes(12).toString('hex')}`])) as Record<
    Role,
    string
  >;
  writeFileSync(join(secretsDir, 'pg_superuser_password'), `pw-${randomBytes(12).toString('hex')}`);
  for (const r of ROLES) writeFileSync(join(secretsDir, `pg_${r.slice(3)}_password`), `${passwords[r]}\n`);

  const image = await docker('GET', `/images/${encodeURIComponent(PG_IMAGE)}/json`);
  if (image.status !== 200) throw new Error(`image ${PG_IMAGE} not present locally: run \`docker pull ${PG_IMAGE}\``);

  const created = await docker('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
    Image: PG_IMAGE,
    Env: ['POSTGRES_DB=app', 'POSTGRES_PASSWORD_FILE=/run/secrets/pg_superuser_password', 'INFRA_DB_DIR=/infra-db'],
    ExposedPorts: { '5432/tcp': {} },
    Labels: { 'fb.test': label },
    HostConfig: {
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Mounts: [
        { Type: 'bind', Source: secretsDir, Target: '/run/secrets', ReadOnly: true },
        { Type: 'bind', Source: INFRA_DB, Target: '/infra-db', ReadOnly: true },
        {
          Type: 'bind',
          Source: join(INFRA_DB, 'init', '00-roles.sh'),
          Target: '/docker-entrypoint-initdb.d/00-roles.sh',
          ReadOnly: true,
        },
      ],
    },
  });
  expectStatus(created, [201], 'create container');
  const id = (JSON.parse(created.body.toString('utf8')) as { Id: string }).Id;

  const remove = async () => {
    await docker('DELETE', `/containers/${id}?force=true&v=true`).catch(() => undefined);
    rmSync(secretsDir, { recursive: true, force: true });
  };
  const logs = async () => demux((await docker('GET', `/containers/${id}/logs?stdout=1&stderr=1`)).body);

  try {
    expectStatus(await docker('POST', `/containers/${id}/start`), [204, 304], 'start container');

    const info = JSON.parse((await docker('GET', `/containers/${id}/json`)).body.toString('utf8')) as {
      NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
    };
    const binding = info.NetworkSettings.Ports['5432/tcp']?.[0];
    if (binding === undefined) throw new Error('no host port bound for 5432/tcp');
    const port = Number(binding.HostPort);
    const host = '127.0.0.1';

    const pool = (role: Role, max = 10): Pool =>
      createPgPool({
        host,
        port,
        database: 'app',
        user: role,
        secrets: { get: () => passwords[role] },
        max,
        applicationName: `${label}-${role}`,
      });

    // wait for the init script to finish, then for the real server to accept fb_owner over TCP
    const deadline = Date.now() + 180_000; // under the 240 s beforeAll timeout, so a slow start fails with the postgres logs
    let ready = false;
    while (Date.now() < deadline) {
      const text = await logs();
      if (/00-roles\.sh: missing|psql: error|ERROR: /.test(text)) throw new Error(`postgres init failed:\n${text}`);
      if (text.includes('PostgreSQL init process complete')) {
        const probe = pool('fb_owner', 1);
        try {
          await probe.query('SELECT 1 FROM app.schema_migrations LIMIT 1');
          ready = true;
        } catch {
          // server restarting after init; retry
        } finally {
          await probe.end();
        }
        if (ready) break;
      }
      await sleep(500);
    }
    if (!ready) throw new Error(`postgres not ready in time:\n${await logs()}`);

    return { name, host, port, pool, logs, stop: remove };
  } catch (err) {
    await remove();
    throw err;
  }
}

/** beforeAll timeout for files that start a container (above startPgContainer's own 180 s readiness deadline). */
export const CONTAINER_HOOK_TIMEOUT_MS = 240_000;
