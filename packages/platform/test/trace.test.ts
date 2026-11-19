import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/http/index.ts';
import {
  childTraceparent,
  generateTraceparent,
  noopTracer,
  parseTraceparent,
  resolveIncomingTrace,
  traceIdFromTraceparent,
} from '../src/trace/index.ts';

describe('traceparent', () => {
  it('generate -> parse round trip', () => {
    const tp = generateTraceparent();
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const p = parseTraceparent(tp);
    expect(p).not.toBeNull();
    expect(`00-${p?.traceId}-${p?.spanId}-${p?.flags}`).toBe(tp);
    expect(traceIdFromTraceparent(tp)).toBe(p?.traceId);
  });

  it('rejects malformed values', () => {
    const bads = [
      '',
      'x',
      `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`,
      `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`,
      `01-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      `00-${'A'.repeat(32)}-${'b'.repeat(16)}-01`,
    ];
    for (const bad of bads) expect(parseTraceparent(bad), bad).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('child keeps trace id, changes span id', () => {
    const tp = generateTraceparent();
    const c = childTraceparent(tp);
    expect(traceIdFromTraceparent(c)).toBe(traceIdFromTraceparent(tp));
    expect(c).not.toBe(tp);
  });

  it('incoming: traceparent wins over a conflicting X-Trace-Id', () => {
    const tp = generateTraceparent();
    const r = resolveIncomingTrace({ traceparent: tp, 'x-trace-id': 'f'.repeat(32) });
    expect(r.traceparent).toBe(tp);
    expect(r.traceId).toBe(traceIdFromTraceparent(tp));
    expect(r.mismatch).toBe(true);
  });

  it('incoming without traceparent generates one', () => {
    const r = resolveIncomingTrace({});
    expect(parseTraceparent(r.traceparent)?.traceId).toBe(r.traceId);
  });

  it('noop tracer propagates the trace id', () => {
    const tp = generateTraceparent();
    const span = noopTracer.startSpan('x', { parent: tp });
    expect(span.traceId).toBe(traceIdFromTraceparent(tp));
    expect(parseTraceparent(span.traceparent)?.spanId).toBe(span.spanId);
    span.setAttribute('a', 1).recordException(new Error('x')).end();
  });
});

describe('http client trace headers', () => {
  let server: Server;
  let base: string;
  const seen: Record<string, string | string[] | undefined>[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends traceparent and X-Trace-Id with the same trace id; caller cannot override', async () => {
    const client = createHttpClient({ baseUrl: base });
    const parent = generateTraceparent();
    const res = await client.get('/x', {
      traceparent: parent,
      headers: { 'X-Trace-Id': 'evil', Traceparent: 'evil' },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const h = seen.at(-1);
    const tp = h?.traceparent as string;
    expect(parseTraceparent(tp)?.traceId).toBe(traceIdFromTraceparent(parent));
    expect(h?.['x-trace-id']).toBe(traceIdFromTraceparent(parent));
    await client.close();
  });

  it('starts a new trace when none is supplied', async () => {
    const client = createHttpClient({ baseUrl: base });
    await client.get('/y');
    const h = seen.at(-1);
    expect(h?.['x-trace-id']).toBe(traceIdFromTraceparent(h?.traceparent as string));
    await client.close();
  });
});
