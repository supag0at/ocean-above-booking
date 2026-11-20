import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev mock layer (src/mocks) uses MSW's fetch fallback, so no Service Worker file is needed.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
