import { createServer as createNetServer } from 'node:net';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { HttpError, buildServer, cidrContains, createServer, parseBind } from '../src/fastify/index.ts';
import { createHttpClient } from '../src/http/index.ts';
import { generateTraceparent, traceIdFromTraceparent } from '../src/trace/index.ts';

describe('cidrContains / parseBind', () => {
  it('matches v4, v4-mapped v6 and rejects others', () => {
    expect(cidrContains(['172.30.2.128/25'], '172.30.2.130')).toBe(true);
    expect(cidrContains(['172.30.2.128/25'], '172.30.2.30')).toBe(false);
    expect(cidrContains(['172.30.1.10/32'], '::ffff:172.30.1.10')).toBe(true);
    expect(cidrContains(['::1/128'], '::1')).toBe(true);
    expect(cidrContains(['127.0.0.1'], undefined)).toBe(false);
    expect(() => cidrContains(['nonsense'], '1.1.1.1')).toThrow();
  });
  it('rejects wildcard and malformed binds', () => {
    expect(parseBind('172.30.1.20:8080')).toEqual({ host: '172.30.1.20', port: 8080 });
    expect(parseBind('[::1]:9')).toEqual({ host: '::1', port: 9 });
    expect(() => parseBind('0.0.0.0:80')).toThrow(/wildcard/);
    expect(() => parseBind(':80')).toThrow();
    expect(() => parseBind('localhost:80')).toThrow();
  });
});

describe('server factory', () => {
  it('peer check: allowed 200, other 403 FORBIDDEN_PEER with envelope; X-Forwarded-For ignored', async () => {
    const app = await buildServer({
      allowedPeers: ['10.0.0.0/24'],
      routes: (a) => void a.get('/p', async () => ({ ok: 1 })),
    });
    const ok = await app.inject({ method: 'GET', url: '/p', remoteAddress: '10.0.0.5' });
    expect(ok.statusCode).toBe(200);
    const no = await app.inject({
      method: 'GET',
      url: '/p',
      remoteAddress: '10.0.1.5',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });
    expect(no.statusCode).toBe(403);
    expect(JSON.parse(no.body).error).toMatchObject({ code: 'FORBIDDEN_PEER' });
    expect(no.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    await app.close();
  });

  it('trace and errors: traceparent honoured, envelope carries traceId, internals not leaked', async () => {
    const app = await buildServer({
      allowedPeers: ['127.0.0.1'],
      routes: (a) => {
        a.get('/boom', async () => {
          throw new Error('secret internals');
        });
        a.get('/typed', async () => {
          throw new HttpError('SESSION_NOT_FOUND', 'no such session');
        });
        a.post('/s', { schema: { body: Type.Object({ a: Type.String() }) } }, async () => ({}));
      },
    });
    const tp = generateTraceparent();
    const traceId = traceIdFromTraceparent(tp);
    const boom = await app.inject({ method: 'GET', url: '/boom', headers: { traceparent: tp } });
    expect(boom.statusCode).toBe(500);
    expect(boom.headers['x-trace-id']).toBe(traceId);
    expect(JSON.parse(boom.body)).toEqual({ error: { code: 'INTERNAL', message: 'internal error', traceId } });
    const typed = await app.inject({ method: 'GET', url: '/typed' });
    expect(typed.statusCode).toBe(404);
    expect(JSON.parse(typed.body).error.code).toBe('SESSION_NOT_FOUND');
    const nf = await app.inject({ method: 'GET', url: '/missing' });
    expect(nf.statusCode).toBe(404);
    const big = await app.inject({ method: 'POST', url: '/s', payload: { a: 'x'.repeat(20000) } });
    expect(big.statusCode).toBe(413);
    expect(JSON.parse(big.body).error.code).toBe('PAYLOAD_TOO_LARGE');
    const bad = await app.inject({
      method: 'POST',
      url: '/s',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('readyz reports 503 SERVICE_UNAVAILABLE when the probe throws', async () => {
    const app = await buildServer({
      allowedPeers: ['127.0.0.1'],
      ready: () => {
        throw new Error('db down');
      },
    });
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('createServer listens on the given interface address and refuses a wildcard', async () => {
    await expect(createServer({ bind: '0.0.0.0:0', allowedPeers: ['127.0.0.1'] })).rejects.toThrow(/wildcard/);
    // fail closed: an address that does not exist on this machine makes listen reject
    await expect(createServer({ bind: '203.0.113.77:0', allowedPeers: ['127.0.0.1'] })).rejects.toThrow();
    const app = await createServer({ bind: '127.0.0.1:0', allowedPeers: ['127.0.0.1'] });
    const addr = app.server.address();
    expect(addr && typeof addr === 'object' ? addr.address : '').toBe('127.0.0.1');
    await app.close();
  });
});

describe('http client timeouts and retries', () => {
  async function flaky(failures: number) {
    let calls = 0;
    const app = await createServer({
      bind: '127.0.0.1:0',
      allowedPeers: ['127.0.0.1'],
      routes: (a) => {
        a.get('/f', async (_req, reply) => (++calls <= failures ? reply.code(503).send({ n: calls }) : { ok: true }));
        a.post('/f', async (_req, reply) => (++calls <= failures ? reply.code(503).send({ n: calls }) : { ok: true }));
        a.get('/slow', async () => {
          await new Promise((r) => setTimeout(r, 300));
          return {};
        });
      },
    });
    const addr = app.server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    return { app, base: `http://127.0.0.1:${port}`, calls: () => calls };
  }

  it('retries idempotent GET on 503 until success', async () => {
    const s = await flaky(2);
    const c = createHttpClient({ baseUrl: s.base, retryBaseDelayMs: 1 });
    const res = await c.get('/f');
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    await c.close();
    await s.app.close();
  });

  it('does not retry a bare POST, retries POST marked idempotent', async () => {
    const s = await flaky(1);
    const c = createHttpClient({ baseUrl: s.base, retryBaseDelayMs: 1 });
    const bare = await c.post('/f', {});
    expect(bare.status).toBe(503);
    expect(bare.attempts).toBe(1);
    expect(s.calls()).toBe(1);
    const keyed = await c.post('/f', {}, { idempotent: true });
    expect(keyed.status).toBe(200);
    await c.close();
    await s.app.close();
  });

  it('times out with HttpTimeoutError and gives up after the retry budget', async () => {
    const s = await flaky(0);
    const c = createHttpClient({ baseUrl: s.base, retryBaseDelayMs: 1, timeoutMs: 50, retries: 1 });
    await expect(c.get('/slow')).rejects.toMatchObject({ name: 'HttpTimeoutError', attempts: 2 });
    await c.close();
    await s.app.close();
  });

  it('network error -> HttpNetworkError', async () => {
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const c = createHttpClient({ baseUrl: `http://127.0.0.1:${port}`, retryBaseDelayMs: 1, retries: 1 });
    await expect(c.get('/')).rejects.toMatchObject({ name: 'HttpNetworkError', attempts: 2 });
    await c.close();
  });
});
