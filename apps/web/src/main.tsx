import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initI18n, pickLocale } from './i18n/index.ts';
import './styles.css';

initI18n(pickLocale(null, navigator.language));

async function boot() {
  // W3: the real backend does not exist yet, so the API is mocked with MSW. W4 (T12a) switches this off.
  if (import.meta.env.VITE_MOCK !== '0') {
    const { startMocks } = await import('./mocks/browser.ts');
    await startMocks();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
