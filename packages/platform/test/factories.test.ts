import { describe, expect, it } from 'vitest';
import { createPgPool } from '../src/pg/index.ts';
import { createRedis } from '../src/redis/index.ts';
import type { SecretProvider } from '../src/secrets/index.ts';

const secrets: SecretProvider = {
  get: (n) => (n === 'pg_password' ? 'pgpw' : n === 'redis_password' ? 'redispw' : 'other'),
};

describe('pg / redis factories take their passwords from SecretProvider', () => {
  it('pg pool', async () => {
    const pool = createPgPool({ host: '127.0.0.1', database: 'app', user: 'fb_hands', secrets });
    const o = pool.options as { password?: string; user?: string; statement_timeout?: number };
    expect(o.password).toBe('pgpw');
    expect(o.user).toBe('fb_hands');
    expect(o.statement_timeout).toBe(5000);
    await pool.end();
  });

  it('redis client uses ACL username + password, lazily', () => {
    const r = createRedis({ host: '127.0.0.1', username: 'gateway', secrets, lazyConnect: true });
    expect(r.options.username).toBe('gateway');
    expect(r.options.password).toBe('redispw');
    expect(r.status).toBe('wait');
    r.disconnect();
  });
});
