// @fb/gateway (T06): public API :8080, session API :8081, SSE fan-out, doorbell and sweeper (A-01 §2–§7).
export { buildGateway, type Gateway, type GatewayDeps } from './app.ts';
export { startGateway, GATEWAY_SECRET_FILES } from './main.ts';
export { loadGatewayConfig, type GatewayConfig } from './config.ts';
export { toPublicEvent, toPublicEphemeral } from './views.ts';
