import { setupWorker } from 'msw/browser';
import { installFetchFallback } from './fallback.ts';
import { createHandlers } from './handlers.ts';

/** Start the in-browser mock backend (dev only; W3 has no real API). */
export async function startMocks() {
  const { handlers } = createHandlers();
  try {
    await setupWorker(...handlers).start({ onUnhandledFrame: 'bypass', quiet: true });
  } catch (e) {
    console.warn('[mock] Service Worker unavailable, using the fetch fallback instead', e);
    installFetchFallback(handlers as Parameters<typeof installFetchFallback>[0]);
  }
}
