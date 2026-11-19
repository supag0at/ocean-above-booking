import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/index.ts';

const schema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535 }),
  PUBLIC_BIND: Type.String({ minLength: 1 }),
  LOG_LEVEL: Type.Union([Type.Literal('info'), Type.Literal('debug')], { default: 'info' }),
});

describe('loadConfig', () => {
  it('picks declared keys, converts types, applies defaults', () => {
    const cfg = loadConfig(schema, { PORT: '8080', PUBLIC_BIND: '172.30.1.20:8080', OTHER: 'ignored' });
    expect(cfg).toEqual({ PORT: 8080, PUBLIC_BIND: '172.30.1.20:8080', LOG_LEVEL: 'info' });
  });

  it('fails startup with every problem listed', () => {
    let err: unknown;
    try {
      loadConfig(schema, { PORT: 'abc' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toMatch(/PORT/);
    expect((err as ConfigError).message).toMatch(/PUBLIC_BIND/);
    expect((err as ConfigError).message).not.toMatch(/abc/); // values are never echoed
  });

  it('rejects secret-looking keys (secrets are files, A-01 §2.3)', () => {
    const bad = Type.Object({ DB_PASSWORD: Type.String(), TOKEN_FILE: Type.String() });
    expect(() => loadConfig(bad, { DB_PASSWORD: 'x', TOKEN_FILE: '/run/secrets/t' })).toThrow(/DB_PASSWORD/);
    expect(() =>
      loadConfig(Type.Object({ TOKEN_FILE: Type.String() }), { TOKEN_FILE: '/run/secrets/t' }),
    ).not.toThrow();
  });
});
