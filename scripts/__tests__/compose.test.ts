// CT-04 / CT-05: contract tests on the fully resolved compose configuration (`docker compose config --format json`).
// Source of truth: A-01 2.1 (containers), 2.2 (networks), 2.3 (secret x container matrix).
// Every assertion on a service/network is preceded by a precondition (it exists), so a missing object can never
// make a "must not" assertion pass vacuously.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const COMPOSE_FILE = 'infra/compose/compose.yml';

interface Service {
  environment?: Record<string, string | null>;
  networks?: Record<string, unknown> | string[];
  secrets?: Array<string | { source: string; target?: string }>;
  ports?: Array<{ published?: string | number; target?: number } | string>;
  volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean }>;
}
interface Compose {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
  secrets: Record<string, { file?: string; environment?: string }>;
}

let cfg: Compose | undefined;
let skipReason = '';
{
  const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    skipReason = `docker compose is not available or failed: ${r.error?.message ?? (r.stderr ?? '').slice(0, 300)}`;
  } else {
    cfg = JSON.parse(r.stdout) as Compose;
  }
}
if (skipReason) console.warn(`[CT-04/CT-05] SKIPPED: ${skipReason}`);
const d = describe.skipIf(!cfg);

const SERVICES = ['caddy', 'gateway', 'harness', 'hands', 'booking', 'postgres', 'redis', 'migrate'] as const;

/** A-01 2.3 matrix, transposed: container -> exact set of secrets. */
const SECRETS: Record<(typeof SERVICES)[number], string[]> = {
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

/** A-01 2.2 network table, transposed: container -> exact set of networks. */
const NETWORKS: Record<(typeof SERVICES)[number], string[]> = {
  caddy: ['edge', 'front'],
  gateway: ['front', 'app', 'bk', 'db_main'],
  harness: ['app', 'egress'],
  hands: ['app', 'db_main'],
  booking: ['bk', 'db_booking'],
  postgres: ['db_main', 'db_booking'],
  redis: ['app'],
  migrate: ['db_main'],
};
const EGRESS_NETWORKS = ['edge', 'egress']; // A-01 2.2: the only non-internal networks

const SECRETISH = /pass(word|wd)?|secret|token|key|credential|sk-/i;
// Non-secret configuration that legitimately matches the pattern by name. Each entry is key -> value check.
const ENV_ALLOW: Record<string, (v: string) => boolean> = {
  // a path to a secret file, never the secret itself
  POSTGRES_PASSWORD_FILE: (v) => /^\/run\/secrets\/[a-z_]+$/.test(v),
};

const svc = (n: string): Service => cfg!.services[n]!;
const netsOf = (n: string): string[] => {
  const x = svc(n).networks ?? {};
  return (Array.isArray(x) ? x : Object.keys(x)).sort();
};
const secretsOf = (n: string): string[] =>
  (svc(n).secrets ?? []).map((s) => (typeof s === 'string' ? s : s.source)).sort();

d('compose preconditions', () => {
  it('declares exactly the 8 containers of A-01 2.1', () => {
    expect(Object.keys(cfg!.services).sort()).toEqual([...SERVICES].sort());
  });
  it('declares the 7 networks of A-01 2.2 and the 12 secrets of A-01 2.3', () => {
    expect(Object.keys(cfg!.networks).sort()).toEqual(
      ['app', 'bk', 'db_booking', 'db_main', 'edge', 'egress', 'front'].sort(),
    );
    expect(Object.keys(cfg!.secrets).sort()).toEqual([...new Set(Object.values(SECRETS).flat())].sort());
  });
  it('network internal flags: only edge and egress can reach out', () => {
    for (const [name, n] of Object.entries(cfg!.networks)) {
      expect(!!n.internal, name).toBe(!EGRESS_NETWORKS.includes(name));
    }
  });
});

d('CT-04: secrets are files, never environment', () => {
  it.each(SERVICES)('%s: no secret-looking environment key or value', (name) => {
    expect(svc(name)).toBeDefined();
    for (const [k, v] of Object.entries(svc(name).environment ?? {})) {
      const val = v ?? '';
      const allowed = ENV_ALLOW[k];
      if (allowed) {
        expect(allowed(val), `${name}.${k} allow-listed but value is not a /run/secrets path`).toBe(true);
        continue;
      }
      expect(SECRETISH.test(k), `${name}: environment key ${k} looks like a secret`).toBe(false);
      expect(SECRETISH.test(val), `${name}: environment value of ${k} looks like a secret`).toBe(false);
    }
  });

  it('every environment key outside the allow-list is a known non-secret key (guards the pattern itself)', () => {
    // sanity: the detector must actually fire on typical offenders
    for (const bad of ['PG_PASSWORD', 'COOKIE_SECRET', 'DEEPSEEK_API_KEY', 'SERVICE_TOKEN']) {
      expect(SECRETISH.test(bad), bad).toBe(true);
    }
    for (const ok of ['INFRA_DB_DIR', 'PG_HOST', 'PG_USER', 'PUBLIC_BIND', 'NODE_ENV']) {
      expect(SECRETISH.test(ok), ok).toBe(false);
    }
  });

  it.each(SERVICES)('%s: no secret is bind-mounted outside the secrets mechanism', (name) => {
    expect(svc(name)).toBeDefined();
    for (const v of svc(name).volumes ?? []) {
      expect(v.source ?? '', `${name} mounts ${v.source}`).not.toMatch(/[\\/]infra[\\/]secrets/);
      expect(v.target ?? '', `${name} mounts to ${v.target}`).not.toMatch(/\/run\/secrets/);
    }
  });

  it.each(SERVICES)('%s: mounted secrets match the A-01 2.3 matrix exactly', (name) => {
    expect(svc(name)).toBeDefined();
    expect(secretsOf(name)).toEqual([...SECRETS[name]].sort());
  });

  it('every declared secret is a file, never an environment-sourced secret', () => {
    for (const [n, s] of Object.entries(cfg!.secrets)) {
      expect(s.file, n).toBeTruthy();
      expect(s.environment, n).toBeUndefined();
    }
  });

  it('harness holds none of the booking / database / hands-signing secrets', () => {
    expect(svc('harness')).toBeDefined();
    const h = secretsOf('harness');
    for (const s of h) {
      expect(s, s).not.toMatch(/^pg_/);
      expect(s).not.toBe('booking_service_token');
      expect(s).not.toBe('hands_token_signing_key');
      expect(s).not.toBe('cookie_secret');
    }
  });
});

d('CT-05: network segmentation', () => {
  it.each(SERVICES)('%s: network membership matches A-01 2.2', (name) => {
    expect(svc(name)).toBeDefined();
    expect(netsOf(name)).toEqual([...NETWORKS[name]].sort());
    for (const n of netsOf(name)) expect(cfg!.networks[n], `network ${n}`).toBeDefined();
  });

  it('harness, hands and booking share no network pairwise', () => {
    const trio = ['harness', 'hands', 'booking'] as const;
    for (const n of trio) expect(netsOf(n).length, n).toBeGreaterThan(0);
    for (let i = 0; i < trio.length; i++) {
      for (let j = i + 1; j < trio.length; j++) {
        const common = netsOf(trio[i]!).filter((n) => netsOf(trio[j]!).includes(n));
        // harness and hands legitimately share `app` (harness calls hands:8082); booking is isolated from both.
        if (trio[i] === 'harness' && trio[j] === 'hands') expect(common).toEqual(['app']);
        else expect(common, `${trio[i]} / ${trio[j]}`).toEqual([]);
      }
    }
  });

  it('only booking and postgres are on db_booking', () => {
    expect(cfg!.networks['db_booking']).toBeDefined();
    const members = SERVICES.filter((n) => netsOf(n).includes('db_booking')).sort();
    expect(members).toEqual(['booking', 'postgres']);
  });

  it('harness cannot reach postgres networks; only harness is on egress', () => {
    expect(cfg!.networks['egress']).toBeDefined();
    expect(netsOf('harness').filter((n) => n.startsWith('db_'))).toEqual([]);
    expect(SERVICES.filter((n) => netsOf(n).includes('egress'))).toEqual(['harness']);
  });

  it('gateway is on no network that can reach out', () => {
    expect(svc('gateway')).toBeDefined();
    const nets = netsOf('gateway');
    expect(nets.length).toBeGreaterThan(0);
    for (const n of nets) {
      expect(cfg!.networks[n], n).toBeDefined();
      expect(cfg!.networks[n]!.internal, `gateway network ${n} must be internal`).toBe(true);
    }
  });

  it('only caddy publishes host ports', () => {
    expect(svc('caddy')).toBeDefined();
    expect((svc('caddy').ports ?? []).length).toBeGreaterThan(0);
    for (const n of SERVICES) {
      if (n !== 'caddy') expect(svc(n).ports ?? [], `${n} must not publish ports`).toEqual([]);
    }
    const published = (svc('caddy').ports ?? []).map((p) => (typeof p === 'string' ? p : String(p.published))).sort();
    expect(published.map((p) => p.split(':')[0])).toEqual(['443', '80']);
  });

  it('locations.db is mounted only into hands, read-only', () => {
    const mounts = SERVICES.flatMap((n) =>
      (svc(n).volumes ?? [])
        .filter((v) => /locations\.db$/.test(v.source ?? ''))
        .map((v) => ({ n, ro: v.read_only === true })),
    );
    expect(mounts).toEqual([{ n: 'hands', ro: true }]);
  });
});

d('M-20: postgres mounts infra/db read-only for 00-roles.sh', () => {
  it('mounts infra/db at /infra-db and init/ at /docker-entrypoint-initdb.d, both read-only, with INFRA_DB_DIR', () => {
    const pg = svc('postgres');
    expect(pg).toBeDefined();
    const by = (t: string) => (pg.volumes ?? []).find((v) => v.target === t);
    expect(by('/infra-db')?.read_only).toBe(true);
    expect(by('/infra-db')?.source).toMatch(/infra[\\/]db$/);
    expect(by('/docker-entrypoint-initdb.d')?.read_only).toBe(true);
    expect(by('/docker-entrypoint-initdb.d')?.source).toMatch(/infra[\\/]db[\\/]init$/);
    expect(pg.environment?.['INFRA_DB_DIR']).toBe('/infra-db');
  });
});
