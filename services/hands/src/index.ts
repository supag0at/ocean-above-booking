// @fb/hands (T08): domain tool service behind POST /internal/execute (A-02 §5, §7; A-01 §5.5).
export { buildHandsServer, handsServerOptions, EXECUTE_PATH, type HandsServerOptions } from './server.ts';
export { createEngine, inputSha256, TOOL_HANDLERS, type Engine, type CallIdentity, type ExecuteCall } from './engine.ts';
export { authenticate, publicKeyMap, type AuthResult } from './auth.ts';
export { loadHandsConfig, HANDS_DEFAULTS, type HandsConfig } from './config.ts';
export { startHands, type StartHandsOptions } from './main.ts';
export type * from './ports.ts';
