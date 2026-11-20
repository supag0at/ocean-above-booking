import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// Browser stays on this origin: relative /api/v1 and credentials: 'same-origin'.
// Gateway CSRF compares Origin to PUBLIC_ORIGIN, which must be exactly http://127.0.0.1:5173.
// changeOrigin stays false so the proxy does not rewrite Host. Do not set `fetch` / `fetchOptions`:
// http-proxy-3 would then buffer the body through fetch() instead of piping the upstream socket.
const gatewayProxy: ProxyOptions = {
  target: 'http://127.0.0.1:8080',
  changeOrigin: false,
  configure: (proxy) => {
    proxy.on('proxyRes', (proxyRes, _req, res) => {
      const raw = proxyRes.headers['content-type'];
      const contentType = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
      if (!contentType.includes('text/event-stream')) return;
      // Forward each SSE frame as the gateway writes it. An idle stream never ends, so waiting
      // for the upstream to close would stall the browser forever.
      proxyRes.headers['cache-control'] = 'no-cache, no-transform';
      proxyRes.headers['x-accel-buffering'] = 'no';
      delete proxyRes.headers['content-length'];
      res.socket?.setNoDelay(true);
      proxyRes.socket?.setNoDelay(true);
    });
  },
};

// The dev mock layer (src/mocks) uses MSW's fetch fallback, so no Service Worker file is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': gatewayProxy },
  },
});
