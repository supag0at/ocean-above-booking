import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initI18n, pickLocale } from './i18n/index.ts';
import './styles.css';

initI18n(pickLocale(null, navigator.language));

async function boot() {
  // Unset VITE_MOCK (the default, including unit tests) keeps MSW. VITE_MOCK=0 skips it so login,
  // sessions, SSE, quotes, tickets, memory and history all use the real gateway via the Vite proxy.
  if (import.meta.env.VITE_MOCK !== '0') {
    const { startMocks } = await import('./mocks/browser.ts');
    await startMocks();
  } else if ('serviceWorker' in navigator) {
    // A worker left from an earlier mock session would still intercept /api.
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
