// @fb/memory — pure domain package (T10). No IO; storage is injected by hands via MemoryStore.
export * from './types.ts';
export { recallPreferences } from './recall.ts';
export { buildProfile, loadProfile, deriveFrequentRoutes, deriveLastTicket } from './profile.ts';
export type { BuildProfileInput } from './profile.ts';
export { renderProfile, PROFILE_HEADER, PROFILE_NONE } from './render.ts';
