// Minimal stand-ins for vite/client types (apps/web tsconfig has `types: []`).
interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  glob<T = unknown>(pattern: string, options?: { query?: string; eager?: boolean; import?: string }): Record<string, T>;
}
declare module '*.css';
