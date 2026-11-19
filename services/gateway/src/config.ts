// Non-secret gateway configuration (A-01 §2.2, §2.3, §4.4). Secrets never come from here: they are files read by
// SecretProvider. Parsed by hand because gateway may not import typebox directly (A-01 §1.2); every problem is
// collected and reported at once, without echoing values.
import { parseBind, parseCidrList } from '@fb/platform/fastify';

export interface GatewayConfig {
  readonly publicBind: string;
  readonly publicAllowedPeers: readonly string[];
  readonly internalBind: string;
  readonly internalAllowedPeers: readonly string[];
  /** exact Origin the browser must send on non-GET requests (A-01 §4.2), e.g. "https://ocean-above.example" */
  readonly publicOrigin: string;
  /** add `Secure` to cookies once there is a domain + TLS (D-23) */
  readonly cookieSecure: boolean;
  readonly pg: { readonly host: string; readonly port: number; readonly database: string; readonly user: string };
  readonly redis: { readonly host: string; readonly port: number; readonly user: string };
  /** base URL of booking, e.g. http://172.30.3.30:8083 */
  readonly bookingUrl: string;
  /** M-10: `stream` (default) forwards agent.delta / agent.reasoning_delta; `off` is an ops kill switch */
  readonly agentDeltaMode: 'stream' | 'off';
  readonly secretsDir: string;
  readonly logLevel: string;
}

export class GatewayConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid gateway configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'GatewayConfigError';
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadGatewayConfig(env: Env = process.env): GatewayConfig {
  const issues: string[] = [];
  const str = (key: string, def?: string): string => {
    const v = env[key];
    if (v === undefined || v === '') {
      if (def !== undefined) return def;
      issues.push(`${key}: required`);
      return '';
    }
    return v;
  };
  const port = (key: string, def: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!/^\d{1,5}$/.test(raw) || n < 1 || n > 65535) issues.push(`${key}: not a port`);
    return n;
  };
  const bind = (key: string): string => {
    const v = str(key);
    if (v !== '') {
      try {
        parseBind(v);
      } catch (e) {
        issues.push(`${key}: ${(e as Error).message}`);
      }
    }
    return v;
  };
  const peers = (key: string): string[] => {
    const list = str(key)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      parseCidrList(list);
    } catch (e) {
      issues.push(`${key}: ${(e as Error).message}`);
    }
    if (list.length === 0) issues.push(`${key}: at least one peer is required`);
    return list;
  };
  const url = (key: string): string => {
    const v = str(key);
    if (v !== '') {
      try {
        const u = new URL(v);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') issues.push(`${key}: must be http(s)`);
      } catch {
        issues.push(`${key}: not a URL`);
      }
    }
    return v;
  };

  const origin = url('PUBLIC_ORIGIN');
  if (origin !== '' && issues.every((i) => !i.startsWith('PUBLIC_ORIGIN'))) {
    if (new URL(origin).origin !== origin) issues.push('PUBLIC_ORIGIN: must be a bare origin (scheme://host[:port])');
  }
  const mode = str('AGENT_DELTA_MODE', 'stream');
  if (mode !== 'stream' && mode !== 'off') issues.push('AGENT_DELTA_MODE: must be stream or off');
  const secure = str('COOKIE_SECURE', '0');
  if (secure !== '0' && secure !== '1') issues.push('COOKIE_SECURE: must be 0 or 1');

  const cfg: GatewayConfig = {
    publicBind: bind('PUBLIC_BIND'),
    publicAllowedPeers: peers('PUBLIC_ALLOWED_PEERS'),
    internalBind: bind('INTERNAL_BIND'),
    internalAllowedPeers: peers('INTERNAL_ALLOWED_PEERS'),
    publicOrigin: origin,
    cookieSecure: secure === '1',
    pg: {
      host: str('PG_HOST'),
      port: port('PG_PORT', 5432),
      database: str('PG_DATABASE', 'app'),
      user: str('PG_USER', 'fb_gateway'),
    },
    redis: { host: str('REDIS_HOST'), port: port('REDIS_PORT', 6379), user: str('REDIS_USER', 'gateway') },
    bookingUrl: url('BOOKING_URL'),
    agentDeltaMode: mode === 'off' ? 'off' : 'stream',
    secretsDir: str('SECRETS_DIR', '/run/secrets'),
    logLevel: str('LOG_LEVEL', 'info'),
  };
  if (issues.length > 0) throw new GatewayConfigError(issues);
  return cfg;
}
