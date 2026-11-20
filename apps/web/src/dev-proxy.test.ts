import { describe, expect, it } from 'vitest';
import type { ProxyOptions } from 'vite';
import config from '../vite.config.ts';

function options(): ProxyOptions {
  const proxy = config.server?.proxy?.['/api'];
  if (typeof proxy !== 'object' || proxy === null) throw new Error('expected /api proxy options');
  return proxy;
}

/** Drive `configure` without taking http-proxy's overloaded `on` signature. */
function emitProxyRes(
  proxy: ProxyOptions,
  proxyRes: { headers: Record<string, string | string[] | undefined>; socket: { setNoDelay: () => void } | null },
  res: { socket: { setNoDelay: () => void } | null },
): void {
  const server = {
    on(event: string, fn: (a: unknown, b: unknown, c: unknown) => void) {
      if (event === 'proxyRes') fn(proxyRes, {}, res);
    },
  };
  proxy.configure?.(server as never, proxy);
}

describe('vite dev proxy (T12a)', () => {
  it('forwards /api to the gateway on this origin', () => {
    const proxy = options();
    expect(config.server?.host).toBe('127.0.0.1');
    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
    expect(proxy.target).toBe('http://127.0.0.1:8080');
    expect(proxy.changeOrigin).toBe(false);
    // A timeout would cut the stream. The fetch path buffers the body; SSE must use the socket pipe.
    expect(proxy.timeout).toBeUndefined();
    expect(proxy.proxyTimeout).toBeUndefined();
    expect(proxy.selfHandleResponse).not.toBe(true);
    expect('fetch' in proxy ? proxy.fetch : undefined).toBeUndefined();
    expect('fetchOptions' in proxy ? proxy.fetchOptions : undefined).toBeUndefined();
  });

  it('marks event-stream responses so the proxy does not buffer them', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'content-length': '999',
    };
    let noDelay = 0;
    const touch = () => {
      noDelay += 1;
    };
    emitProxyRes(options(), { headers, socket: { setNoDelay: touch } }, { socket: { setNoDelay: touch } });
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(headers['x-accel-buffering']).toBe('no');
    expect(headers['content-length']).toBeUndefined();
    expect(noDelay).toBe(2);
  });

  it('does not rewrite ordinary API responses', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'content-type': 'application/json',
      'content-length': '2',
    };
    emitProxyRes(options(), { headers, socket: null }, { socket: null });
    expect(headers['content-length']).toBe('2');
    expect(headers['x-accel-buffering']).toBeUndefined();
  });
});
