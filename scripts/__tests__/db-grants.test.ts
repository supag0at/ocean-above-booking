// CT-06: database grants (A-01 3.3) verified against a real Postgres 16 in a throw-away container.
// Runs infra/db/init/00-roles.sh (roles + migrations + grants), then connects as every role over TCP (password auth)
// via `docker exec psql` (no pg dependency in scripts/). Every assertion is preceded by a precondition check
// (role exists, table exists) so a missing object can never make a "denied" assertion pass vacuously.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const INFRA_DB = join(ROOT, 'infra', 'db');

function docker(args: string[], input?: string) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 110_000 });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

const dockerOk = docker(['info', '--format', '{{.ServerVersion}}']).status === 0;
if (!dockerOk) console.warn('[CT-06] SKIPPED: docker daemon is not available on this machine');

const ROLES = ['fb_owner', 'fb_gateway', 'fb_hands', 'fb_booking'] as const;
type Role = (typeof ROLES)[number];
const name = `fb-ct06-${randomBytes(4).toString('hex')}`;
const pw = Object.fromEntries(ROLES.map((r) => [r, `pw-${randomBytes(12).toString('hex')}`])) as Record<Role, string>;
const superPw = `pw-${randomBytes(12).toString('hex')}`;
let secretsDir = '';
// The image trusts loopback (pg_hba), so connect via the container's own bridge IP to force scram password auth.
let pgHost = '127.0.0.1';

/** Run SQL as `role` over TCP with the role's password. Probes run inside BEGIN..ROLLBACK so they leave no trace. */
function sql(role: Role, statements: string, opts: { password?: string; rollback?: boolean } = {}) {
  const body = opts.rollback === false ? statements : `BEGIN;\n${statements}\nROLLBACK;`;
  return docker(
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${opts.password ?? pw[role]}`,
      name,
      'psql',
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      pgHost,
      '-U',
      role,
      '-d',
      'app',
    ],
    body,
  );
}
const ok = (role: Role, s: string) => {
  const r = sql(role, s);
  expect(r.status, `${role}: ${s}\n${r.out}`).toBe(0);
};
const denied = (role: Role, s: string, pattern: RegExp = /permission denied/) => {
  const r = sql(role, s);
  expect(r.status, `${role} should be denied: ${s}`).not.toBe(0);
  expect(r.out, `${role}: ${s}`).toMatch(pattern);
};
const scalar = (s: string) => {
  const r = sql('fb_owner', s, { rollback: false });
  expect(r.status, r.out).toBe(0);
  return r.stdout.trim();
};

const Q = (n: number) => `q_${String(n).padStart(26, '0')}`;
const T = (n: number) => `t_${String(n).padStart(26, '0')}`;
const U = '00000000-0000-0000-0000-000000000001';
const S = '00000000-0000-0000-0000-0000000000a1';
const M = '00000000-0000-0000-0000-0000000000b1';

describe.skipIf(!dockerOk)('CT-06: database grants on a real Postgres 16', () => {
  beforeAll(() => {
    secretsDir = mkdtempSync(join(tmpdir(), 'fb-ct06-'));
    writeFileSync(join(secretsDir, 'pg_superuser_password'), superPw);
    // trailing newline is stripped by the script
    for (const r of ROLES) writeFileSync(join(secretsDir, `pg_${r.slice(3)}_password`), `${pw[r]}\n`);
    const run = docker([
      'run',
      '-d',
      '--name',
      name,
      '-e',
      'POSTGRES_DB=app',
      '-e',
      'POSTGRES_PASSWORD_FILE=/run/secrets/pg_superuser_password',
      '-e',
      'INFRA_DB_DIR=/infra-db',
      '-v',
      `${secretsDir}:/run/secrets:ro`,
      '-v',
      `${INFRA_DB}:/infra-db:ro`,
      '-v',
      `${join(INFRA_DB, 'init', '00-roles.sh')}:/docker-entrypoint-initdb.d/00-roles.sh:ro`,
      'postgres:16',
    ]);
    expect(run.status, run.out).toBe(0);
    const deadline = Date.now() + 100_000;
    let ready = false;
    while (Date.now() < deadline) {
      const logs = docker(['logs', name]).out;
      if (/00-roles\.sh: missing|psql: error|ERROR: /.test(logs)) break;
      if (
        logs.includes('PostgreSQL init process complete') &&
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0
      ) {
        ready = true;
        break;
      }
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
    }
    expect(ready, docker(['logs', name]).out).toBe(true);

    pgHost = docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name]).stdout.trim();
    expect(pgHost).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // fixtures (committed, as fb_owner; owner bypasses privileges, triggers still apply)
    const fx = sql(
      'fb_owner',
      `INSERT INTO app.users (id, username, username_norm, locale) VALUES ('${U}','Ann','ann','en');
       INSERT INTO app.sessions (id, user_id, locale) VALUES ('${S}','${U}','en');
       INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload) VALUES ('${Q(1)}','${U}','${S}','A','B','x','{}');
       INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload) VALUES ('${Q(2)}','${U}','${S}','A','B','x','{}');
       INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload) VALUES ('${Q(3)}','${U}','${S}','A','B','x','{}');
       INSERT INTO app.events (session_id, seq, type, actor, trace_id, idempotency_key, payload) VALUES ('${S}',1,'user.message','user','tr','k1','{}');
       INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ('${Q(1)}','${S}','tc1');
       INSERT INTO app.tool_calls (session_id, run_id, tool_call_id, name, input_sha256, response) VALUES ('${S}','r1','tc1','n','h','{}');
       INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary, total_distance_km, price_cents)
         VALUES ('${T(1)}','OA-00000001','${U}','${S}','${Q(1)}','A','B','{}',1.5,100);
       INSERT INTO app.user_memories (id, user_id, key, value, source_session_id, source_seq) VALUES ('${M}','${U}','home_city','A','${S}',1);`,
      { rollback: false },
    );
    expect(fx.status, fx.out).toBe(0);
  });

  afterAll(() => {
    if (!dockerOk) return;
    docker(['rm', '-f', '-v', name]);
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  });

  describe('preconditions: roles and tables exist', () => {
    it('all four roles exist, are LOGIN, not superuser; harness has no role (H-06)', () => {
      expect(scalar(`SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'fb\\_%'`)).toBe(
        'fb_booking,fb_gateway,fb_hands,fb_owner',
      );
      expect(
        scalar(
          `SELECT count(*) FROM pg_roles WHERE rolname LIKE 'fb\\_%' AND (rolsuper OR NOT rolcanlogin OR rolcreaterole OR rolcreatedb)`,
        ),
      ).toBe('0');
      expect(scalar(`SELECT count(*) FROM pg_roles WHERE rolname ILIKE '%harness%'`)).toBe('0');
    });
    it('app schema has exactly the tables of A-01 3.2 (+ schema_migrations), all owned by fb_owner', () => {
      expect(scalar(`SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='app'`)).toBe(
        'events,memory_deletions,quote_offers,quotes,schema_migrations,sessions,tickets,tool_calls,user_memories,users',
      );
      expect(scalar(`SELECT count(*) FROM pg_tables WHERE schemaname='app' AND tableowner <> 'fb_owner'`)).toBe('0');
    });
    it('passwords are checked: wrong password cannot connect', () => {
      const r = sql('fb_gateway', 'SELECT 1', { password: 'wrong' });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/password authentication failed/);
    });
    it('M-8 consumption-tracking columns exist on sessions; messageJson/processText are not columns (D-54, M-2)', () => {
      const cols = scalar(
        `SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='app' AND table_name='sessions'`,
      ).split(',');
      for (const c of [
        'last_user_seq',
        'consumed_up_to_seq',
        'open_run_id',
        'oldest_unconsumed_at',
        'last_agent_event_at',
      ])
        expect(cols).toContain(c);
      expect(
        scalar(
          `SELECT count(*) FROM information_schema.columns WHERE table_schema='app' AND column_name IN ('processText','process_text','messageJson','message_json','view_text')`,
        ),
      ).toBe('0');
      expect(
        scalar(
          `SELECT data_type FROM information_schema.columns WHERE table_schema='app' AND table_name='events' AND column_name='payload'`,
        ),
      ).toBe('jsonb');
    });
  });

  describe('privilege matrix equals A-01 3.3 exactly', () => {
    const tables = [
      'users',
      'sessions',
      'events',
      'quotes',
      'quote_offers',
      'tool_calls',
      'tickets',
      'user_memories',
      'memory_deletions',
      'schema_migrations',
    ];
    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    // table-level grants only (column-level UPDATE/SELECT are checked separately below)
    const allowed: Record<string, Record<string, string[]>> = {
      fb_gateway: {
        users: ['SELECT', 'INSERT'],
        sessions: ['SELECT', 'INSERT'],
        events: ['SELECT', 'INSERT'],
        quotes: ['SELECT'],
        quote_offers: ['SELECT'],
        tickets: ['SELECT'],
        user_memories: ['SELECT'],
        memory_deletions: ['SELECT', 'INSERT'],
      },
      fb_hands: {
        quotes: ['SELECT', 'INSERT'],
        quote_offers: ['SELECT', 'INSERT'],
        tool_calls: ['SELECT', 'INSERT'],
        tickets: ['SELECT'],
        user_memories: ['SELECT', 'INSERT'],
        memory_deletions: ['SELECT'],
      },
      fb_booking: { quotes: ['SELECT'], quote_offers: ['SELECT'], tickets: ['SELECT', 'INSERT'] },
    };
    for (const role of ['fb_gateway', 'fb_hands', 'fb_booking'] as const) {
      it(`${role}: exactly the table-level privileges of the matrix, nothing else`, () => {
        for (const t of tables) {
          for (const p of privs) {
            const expected = allowed[role]?.[t]?.includes(p) ?? false;
            const got = scalar(`SELECT has_table_privilege('${role}', 'app.${t}', '${p}')`) === 't';
            expect(got, `${role} ${p} ON app.${t}`).toBe(expected);
          }
        }
      });
    }
    it('column-level: gateway UPDATE only users.locale + listed sessions columns; hands SELECT only (id,user_id,last_user_seq) of sessions', () => {
      const upd = (role: Role, t: string) =>
        scalar(
          `SELECT coalesce(string_agg(column_name, ',' ORDER BY column_name), '') FROM information_schema.columns WHERE table_schema='app' AND table_name='${t}' AND has_column_privilege('${role}', 'app.${t}', column_name, 'UPDATE')`,
        );
      expect(upd('fb_gateway', 'users')).toBe('locale');
      expect(upd('fb_gateway', 'sessions').split(',').sort()).toEqual(
        [
          'title',
          'last_seq',
          'last_user_seq',
          'last_user_at',
          'oldest_unconsumed_at',
          'consumed_up_to_seq',
          'open_run_id',
          'last_agent_event_at',
          'last_run_outcome',
          'max_fence_seen',
          'status',
          'updated_at',
        ].sort(),
      );
      for (const t of [
        'events',
        'quotes',
        'tickets',
        'tool_calls',
        'user_memories',
        'memory_deletions',
        'quote_offers',
      ])
        expect(upd('fb_gateway', t), t).toBe('');
      for (const role of ['fb_hands', 'fb_booking'] as const)
        for (const t of tables) expect(upd(role, t), `${role} ${t}`).toBe('');
      const sel = scalar(
        `SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='app' AND table_name='sessions' AND has_column_privilege('fb_hands','app.sessions',column_name,'SELECT')`,
      );
      expect(sel).toBe('id,last_user_seq,user_id');
    });
  });

  describe('allowed operations succeed (each role, exactly what A-01 3.3 lists)', () => {
    it('fb_gateway', () => {
      ok(
        'fb_gateway',
        `SELECT * FROM app.users; SELECT * FROM app.sessions; SELECT * FROM app.events; SELECT * FROM app.quotes; SELECT * FROM app.quote_offers; SELECT * FROM app.tickets; SELECT * FROM app.user_memories; SELECT * FROM app.memory_deletions;`,
      );
      ok(
        'fb_gateway',
        `INSERT INTO app.users (username, username_norm) VALUES ('Bob','bob'); UPDATE app.users SET locale='zh' WHERE id='${U}';`,
      );
      ok(
        'fb_gateway',
        `INSERT INTO app.sessions (user_id, locale) VALUES ('${U}','zh');
        UPDATE app.sessions SET title='t', last_seq=2, last_user_seq=1, last_user_at=now(), oldest_unconsumed_at=now(), consumed_up_to_seq=0, open_run_id='r', last_agent_event_at=now(), last_run_outcome='failed', max_fence_seen=3, status='running', updated_at=now() WHERE id='${S}';`,
      );
      ok(
        'fb_gateway',
        `INSERT INTO app.events (session_id, seq, type, actor, trace_id, idempotency_key, payload) VALUES ('${S}',2,'agent.message','agent','tr','k2','{"processText":"x"}');`,
      );
      ok('fb_gateway', `INSERT INTO app.memory_deletions (memory_id, user_id) VALUES ('${M}','${U}');`);
    });
    it('fb_hands', () => {
      ok('fb_hands', `SELECT id, user_id, last_user_seq FROM app.sessions;`);
      ok(
        'fb_hands',
        `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload) VALUES ('${Q(4)}','${U}','${S}','A','B','x','{}');
        INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ('${Q(2)}','${S}','tc9');
        INSERT INTO app.tool_calls (session_id, run_id, tool_call_id, name, input_sha256, response) VALUES ('${S}','r1','tc2','n','h','{}');
        INSERT INTO app.user_memories (user_id, key, value, source_session_id, source_seq) VALUES ('${U}','preferred_language','zh','${S}',1);`,
      );
      ok(
        'fb_hands',
        `SELECT * FROM app.quotes; SELECT * FROM app.quote_offers; SELECT * FROM app.tool_calls; SELECT * FROM app.tickets; SELECT * FROM app.user_memories; SELECT * FROM app.memory_deletions;`,
      );
    });
    it('fb_booking', () => {
      ok('fb_booking', `SELECT * FROM app.quotes; SELECT * FROM app.quote_offers; SELECT * FROM app.tickets;`);
      ok(
        'fb_booking',
        `INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary, total_distance_km, price_cents)
        VALUES ('${T(2)}','OA-00000002','${U}','${S}','${Q(2)}','A','B','{}',2.0,200);`,
      );
    });
  });

  describe('forbidden operations fail', () => {
    it('events is append-only: no role can UPDATE or DELETE it (runtime roles by privilege, owner by trigger)', () => {
      expect(scalar(`SELECT count(*) FROM app.events`)).toBe('1'); // precondition: there is a row to try to change
      for (const role of ['fb_gateway', 'fb_hands', 'fb_booking'] as const) {
        denied(role, `UPDATE app.events SET type='x';`);
        denied(role, `DELETE FROM app.events;`);
        denied(role, `TRUNCATE app.events;`);
      }
      denied('fb_owner', `UPDATE app.events SET type='x';`, /append-only table events/);
      denied('fb_owner', `DELETE FROM app.events;`, /append-only table events/);
      denied('fb_owner', `TRUNCATE app.events;`, /append-only table events/);
      expect(scalar(`SELECT count(*) FROM app.events WHERE type='x'`)).toBe('0');
    });
    it('only booking can INSERT tickets (gateway, hands denied); nobody can UPDATE/DELETE them', () => {
      const ins = (q: number, t: number) =>
        `INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary, total_distance_km, price_cents) VALUES ('${T(t)}','OA-0000000${t}','${U}','${S}','${Q(q)}','A','B','{}',1,1);`;
      denied('fb_gateway', ins(3, 5));
      denied('fb_hands', ins(3, 5));
      for (const role of ['fb_gateway', 'fb_hands', 'fb_booking'] as const) {
        denied(role, `UPDATE app.tickets SET status='issued';`);
        denied(role, `DELETE FROM app.tickets;`);
      }
      denied('fb_owner', `UPDATE app.tickets SET status='issued';`, /append-only table tickets/);
      denied('fb_owner', `DELETE FROM app.tickets;`, /append-only table tickets/);
      // control: booking can run the same statement (so the denials above are about the role, not the data)
      ok('fb_booking', ins(3, 5));
      // one ticket per quote (O-1)
      const dup = sql('fb_booking', ins(1, 6));
      expect(dup.status).not.toBe(0);
      expect(dup.out).toMatch(/duplicate key|unique/i);
    });
    it('gateway: no writes to quotes/quote_offers/tool_calls/user_memories, no reads of tool_calls', () => {
      denied(
        'fb_gateway',
        `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload) VALUES ('${Q(9)}','${U}','${S}','A','B','x','{}');`,
      );
      denied(
        'fb_gateway',
        `INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ('${Q(2)}','${S}','z');`,
      );
      denied(
        'fb_gateway',
        `INSERT INTO app.tool_calls (session_id, run_id, tool_call_id, name, input_sha256, response) VALUES ('${S}','r','z','n','h','{}');`,
      );
      denied(
        'fb_gateway',
        `INSERT INTO app.user_memories (user_id, key, value, source_session_id, source_seq) VALUES ('${U}','home_city','A','${S}',1);`,
      );
      denied('fb_gateway', `SELECT * FROM app.tool_calls;`);
      denied('fb_gateway', `UPDATE app.users SET username='hax';`);
      denied('fb_gateway', `UPDATE app.sessions SET user_id='${U}';`);
      denied('fb_gateway', `DELETE FROM app.sessions;`);
    });
    it('hands: cannot write tickets/events/sessions/users/memory_deletions; cannot read other session columns or tables', () => {
      denied(
        'fb_hands',
        `INSERT INTO app.tickets (id, ticket_no, user_id, session_id, quote_id, from_city, to_city, itinerary, total_distance_km, price_cents) VALUES ('${T(7)}','OA-00000007','${U}','${S}','${Q(3)}','A','B','{}',1,1);`,
      );
      denied(
        'fb_hands',
        `INSERT INTO app.events (session_id, seq, type, actor, trace_id, idempotency_key, payload) VALUES ('${S}',9,'x','agent','t','k9','{}');`,
      );
      denied('fb_hands', `UPDATE app.sessions SET title='x';`);
      denied('fb_hands', `INSERT INTO app.users (username, username_norm) VALUES ('h','h');`);
      denied('fb_hands', `INSERT INTO app.memory_deletions (memory_id, user_id) VALUES ('${M}','${U}');`);
      denied('fb_hands', `UPDATE app.quotes SET from_city='x';`);
      denied('fb_hands', `DELETE FROM app.tool_calls;`);
      denied('fb_hands', `SELECT * FROM app.sessions;`);
      denied('fb_hands', `SELECT title FROM app.sessions;`);
      denied('fb_hands', `SELECT * FROM app.events;`);
      denied('fb_hands', `SELECT * FROM app.users;`);
    });
    it('booking: reads only quotes/quote_offers/tickets; writes only tickets', () => {
      for (const t of ['users', 'sessions', 'events', 'tool_calls', 'user_memories', 'memory_deletions'])
        denied('fb_booking', `SELECT * FROM app.${t};`);
      denied(
        'fb_booking',
        `INSERT INTO app.quotes (id, user_id, session_id, from_city, to_city, data_sha256, payload) VALUES ('${Q(9)}','${U}','${S}','A','B','x','{}');`,
      );
      denied(
        'fb_booking',
        `INSERT INTO app.quote_offers (quote_id, session_id, tool_call_id) VALUES ('${Q(2)}','${S}','z');`,
      );
      denied(
        'fb_booking',
        `INSERT INTO app.events (session_id, seq, type, actor, trace_id, idempotency_key, payload) VALUES ('${S}',9,'x','system','t','k9','{}');`,
      );
    });
    it('PUBLIC has nothing: runtime roles cannot CREATE in schema app or read schema_migrations', () => {
      for (const role of ['fb_gateway', 'fb_hands', 'fb_booking'] as const) {
        denied(role, `CREATE TABLE app.evil (x int);`);
        denied(role, `SELECT * FROM app.schema_migrations;`);
      }
    });
  });

  describe('init script is idempotent', () => {
    it('re-running 00-roles.sh succeeds, changes nothing, and keeps passwords working', () => {
      const probe = `SELECT (SELECT count(*) FROM app.events) || '/' || (SELECT count(*) FROM app.schema_migrations)`;
      const before = scalar(probe);
      const r = docker(['exec', '-u', 'postgres', name, 'bash', '/docker-entrypoint-initdb.d/00-roles.sh']);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/migration 0001_init already applied/);
      expect(scalar(probe)).toBe(before);
      ok('fb_gateway', 'SELECT 1 FROM app.users');
      denied('fb_gateway', `INSERT INTO app.quotes (id) VALUES ('x');`);
    });
  });
});
