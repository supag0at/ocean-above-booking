// A-01 §10 checks against the running `ocean-above` stack. Exit 0 only when all five pass.
// Secret values are never printed.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PROJECT = 'ocean-above';
const COMPOSE_FILE = 'infra/compose/compose.yml';
const LOCATIONS_SHA256 = 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f';

/** Same matrix as SECRETS in scripts/__tests__/compose.test.ts (A-01 §2.3). */
const SECRETS: Record<string, readonly string[]> = {
  caddy: [],
  gateway: [
    'pg_gateway_password',
    'redis_gateway_password',
    'harness_service_token',
    'booking_service_token',
    'hands_token_signing_key',
    'cookie_secret',
  ],
  harness: ['redis_harness_password', 'deepseek_api_key', 'harness_service_token'],
  hands: ['pg_hands_password'],
  booking: ['pg_booking_password', 'booking_service_token'],
  postgres: [
    'pg_superuser_password',
    'pg_owner_password',
    'pg_gateway_password',
    'pg_hands_password',
    'pg_booking_password',
  ],
  redis: ['redis_gateway_password', 'redis_harness_password'],
  migrate: ['pg_owner_password'],
};

const SERVICES = Object.keys(SECRETS);
const ENV_NAME = /PASSWORD|SECRET|TOKEN|KEY/i;

interface Mount {
  Destination?: string;
  RW?: boolean;
}
interface Inspected {
  Config?: { Env?: string[] | null };
  Mounts?: Mount[];
  State?: { Running?: boolean; Status?: string; ExitCode?: number; Health?: { Status?: string } };
}

function fail(message: string): never {
  console.error(`verify-deploy: ${message}`);
  process.exit(1);
}

function docker(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { status: 1, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function compose(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  return docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args]);
}

function containerId(service: string): string {
  const r = compose(['ps', '-aq', service]);
  if (r.status !== 0) fail(`cannot list ${service}`);
  const ids = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length !== 1) fail(`${service}: expected 1 container, found ${ids.length}`);
  const id = ids[0];
  if (id === undefined) fail(`${service}: missing container id`);
  return id;
}

function inspect(id: string, service: string): Inspected {
  const r = docker(['inspect', id]);
  if (r.status !== 0) fail(`${service}: inspect failed`);
  let parsed: Inspected[];
  try {
    parsed = JSON.parse(r.stdout) as Inspected[];
  } catch {
    fail(`${service}: inspect output was not JSON`);
  }
  const info = parsed[0];
  if (info === undefined) fail(`${service}: empty inspect`);
  return info;
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((v, i) => v === e[i]);
}

function listSecrets(id: string, service: string, running: boolean): string[] {
  if (running) {
    const r = docker(['exec', id, 'ls', '-1', '/run/secrets']);
    if (r.status !== 0) {
      const err = `${r.stderr}\n${r.stdout}`;
      if (/No such file or directory|cannot access/i.test(err)) return [];
      fail(`${service}: ls /run/secrets failed`);
    }
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
  }
  const info = inspect(id, service);
  const names = (info.Mounts ?? [])
    .map((m) => (m.Destination ?? '').replace(/\\/g, '/'))
    .filter((d) => d.startsWith('/run/secrets/'))
    .map((d) => d.slice('/run/secrets/'.length))
    .filter((n) => n.length > 0 && !n.includes('/'));
  return [...new Set(names)].sort();
}

function envAllowed(key: string, value: string): boolean {
  return key === 'POSTGRES_PASSWORD_FILE' && /^\/run\/secrets\/[a-z0-9_]+$/.test(value);
}

function loadSecretValues(): { name: string; value: string }[] {
  const dir = join(ROOT, 'infra', 'secrets');
  const out: { name: string; value: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.example')) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const value = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
    if (value.length > 0) out.push({ name, value });
  }
  return out;
}

function checkEnv(service: string, env: readonly string[], secrets: readonly { name: string; value: string }[]): void {
  for (const entry of env) {
    const eq = entry.indexOf('=');
    const key = eq === -1 ? entry : entry.slice(0, eq);
    const value = eq === -1 ? '' : entry.slice(eq + 1);
    if (ENV_NAME.test(key) && !envAllowed(key, value)) {
      fail(`${service}: environment name ${key} looks like a secret`);
    }
    for (const secret of secrets) {
      if (value.includes(secret.value)) {
        fail(`${service}: environment ${key} contains the contents of ${secret.name}`);
      }
    }
  }
}

const TCP_PROBE = `
import net from 'node:net';
const host = process.argv[1];
const port = Number(process.argv[2]);
const s = net.connect({ host, port });
const t = setTimeout(() => { s.destroy(); process.exit(2); }, 3000);
s.once('connect', () => { clearTimeout(t); s.destroy(); process.exit(0); });
s.once('error', () => { clearTimeout(t); process.exit(2); });
`;

const HTTP_FORBIDDEN = `
const url = process.argv[1];
const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
const body = await res.text();
if (res.status === 403 && body.includes('FORBIDDEN_PEER')) process.exit(0);
process.stdout.write(String(res.status) + '\\n');
process.exit(1);
`;

const PG_HBA = `
import { createRequire } from 'node:module';
const require = createRequire('/app/packages/platform/package.json');
const pg = require('pg');
const client = new pg.Client({
  host: '172.30.4.10',
  port: 5432,
  database: 'app',
  user: 'fb_booking',
  password: 't14-pg-hba-probe',
  connectionTimeoutMillis: 4000,
});
try {
  await client.connect();
  await client.end().catch(() => {});
  process.exit(0);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  const message = err instanceof Error ? err.message : '';
  process.stdout.write(code + '\\n');
  if (message.includes('pg_hba') || code === '28000') process.exit(2);
  process.exit(1);
}
`;

const LOCATIONS = `
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync } from 'node:fs';
const path = '/data/locations.db';
const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
process.stdout.write(hash + '\\n');
try {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
  closeSync(fd);
  process.exit(3);
} catch {
  process.exit(0);
}
`;

function execNode(
  id: string,
  code: string,
  args: readonly string[] = [],
): { status: number; stdout: string; stderr: string } {
  return docker(['exec', id, 'node', '--input-type=module', '-e', code, ...args]);
}

function expectUnreachable(service: string, id: string, host: string, port: string): void {
  const r = execNode(id, TCP_PROBE, [host, port]);
  if (r.status === 0) fail(`${service} reached ${host}:${port}`);
  if (r.status === 2) {
    console.log(`verify-deploy: ${service} -> ${host}:${port} unreachable`);
    return;
  }
  fail(`${service} -> ${host}:${port} probe failed`);
}

function main(): void {
  const ids = new Map<string, string>();
  const info = new Map<string, Inspected>();
  for (const service of SERVICES) {
    const id = containerId(service);
    ids.set(service, id);
    info.set(service, inspect(id, service));
  }

  for (const service of SERVICES) {
    const id = ids.get(service);
    const expected = SECRETS[service];
    const row = info.get(service);
    if (id === undefined || expected === undefined || row === undefined) fail(`${service}: missing metadata`);
    const running = row.State?.Running === true;
    const names = listSecrets(id, service, running);
    if (!sameSet(names, expected)) {
      fail(`${service}: /run/secrets is [${names.join(', ')}], expected [${[...expected].sort().join(', ')}]`);
    }
  }
  console.log('verify-deploy: 1 secret files match the matrix');

  const secretValues = loadSecretValues();
  if (secretValues.length < 12) fail('fewer than 12 secret files on the host');
  for (const service of SERVICES) {
    const row = info.get(service);
    if (row === undefined) fail(`${service}: missing inspect`);
    checkEnv(service, row.Config?.Env ?? [], secretValues);
  }
  console.log('verify-deploy: 2 environment has no secret names or values');

  const harness = ids.get('harness');
  const hands = ids.get('hands');
  const gateway = ids.get('gateway');
  if (harness === undefined || hands === undefined || gateway === undefined) fail('missing probe containers');
  expectUnreachable('harness', harness, '172.30.1.20', '8080');
  expectUnreachable('harness', harness, '172.30.3.30', '8083');
  const peer = execNode(hands, HTTP_FORBIDDEN, ['http://172.30.2.20:8081/readyz']);
  if (peer.status !== 0)
    fail(`hands -> gateway:8081 expected 403 FORBIDDEN_PEER, status ${peer.stdout.trim() || peer.status}`);
  console.log('verify-deploy: hands -> 172.30.2.20:8081 is 403 FORBIDDEN_PEER');
  expectUnreachable('gateway', gateway, '1.1.1.1', '443');
  console.log('verify-deploy: 3 reachability spot checks passed');

  const hba = execNode(hands, PG_HBA);
  if (hba.status === 0) fail('hands connected to postgres as fb_booking');
  if (hba.status !== 2)
    fail(`hands -> fb_booking was not a pg_hba rejection (exit ${hba.status}, code ${hba.stdout.trim()})`);
  console.log('verify-deploy: 4 fb_booking from hands rejected by pg_hba');

  const handsInfo = info.get('hands');
  if (handsInfo === undefined) fail('hands inspect missing');
  const mount = (handsInfo.Mounts ?? []).find(
    (m) => (m.Destination ?? '').replace(/\\/g, '/') === '/data/locations.db',
  );
  if (mount === undefined || mount.RW !== false) fail('locations.db is not a read-only mount on hands');
  const loc = execNode(hands, LOCATIONS);
  const hash = loc.stdout.trim();
  if (loc.status !== 0) fail(`locations.db is writable or unreadable (exit ${loc.status})`);
  if (hash !== LOCATIONS_SHA256) fail('locations.db sha256 does not match the contract constant');
  console.log('verify-deploy: 5 locations.db is read-only and the sha256 matches');
  console.log('verify-deploy: ok');
}

main();
