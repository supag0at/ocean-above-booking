import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/log/index.ts';

function capture(secretValues?: () => string[]) {
  const lines: string[] = [];
  const log = createLogger({
    service: 'test',
    destination: { write: (l) => void lines.push(l) },
    ...(secretValues ? { secretValues } : {}),
  });
  return { log, out: () => lines.join('') };
}

const DEEPSEEK = ['sk', '0123456789abcdef0123456789abcdef'].join('-'); // built at runtime so the secret scanner does not flag the test

describe('log redaction', () => {
  it('has the fixed fields', () => {
    const { log, out } = capture();
    log.info({ traceId: 't' }, 'hello');
    const rec = JSON.parse(out()) as Record<string, unknown>;
    expect(rec).toMatchObject({ level: 'info', service: 'test', traceId: 't', msg: 'hello' });
    expect(typeof rec.ts).toBe('string');
  });

  it('redacts cookie / authorization / secret-like fields at several depths', () => {
    const { log, out } = capture();
    log.info(
      {
        req: {
          headers: { cookie: 'fb_sid=COOKIEVAL', authorization: 'Bearer BEARERVAL1234', 'x-csrf-token': 'CSRFVAL' },
        },
        password: 'PWVAL',
        nested: { token: 'TOKENVAL', apiKey: 'APIKEYVAL' },
        deep: { a: { cookieSecret: 'CSVAL' } },
        headers: { 'set-cookie': 'SETCOOKIEVAL' },
        userMessage: 'USERTEXT',
        llmText: 'LLMTEXT',
      },
      'request',
    );
    const s = out();
    const values = [
      'COOKIEVAL',
      'BEARERVAL',
      'CSRFVAL',
      'PWVAL',
      'TOKENVAL',
      'APIKEYVAL',
      'CSVAL',
      'SETCOOKIEVAL',
      'USERTEXT',
      'LLMTEXT',
    ];
    for (const v of values) expect(s, v).not.toContain(v);
    expect(s).toContain('[Redacted]');
  });

  it('masks DeepSeek key shaped values anywhere, including in msg and unknown fields', () => {
    const { log, out } = capture();
    log.error({ weird: { place: `key=${DEEPSEEK}` } }, `failed with ${DEEPSEEK}`);
    expect(out()).not.toContain(DEEPSEEK);
    expect(out()).not.toContain('0123456789abcdef');
  });

  it('masks values returned by the SecretProvider', () => {
    const secret = 'correct horse "battery" staple';
    const { log, out } = capture(() => [secret]);
    log.info({ anything: secret }, `oops ${secret}`);
    expect(out()).not.toContain('battery');
  });

  it('non-sensitive fields survive', () => {
    const { log, out } = capture();
    log.info({ route: '/api/v1/sessions', status: 200, durationMs: 3 }, 'done');
    expect(JSON.parse(out())).toMatchObject({ route: '/api/v1/sessions', status: 200, durationMs: 3 });
  });
});
