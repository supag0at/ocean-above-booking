// booking configuration (A-01 §2.2, §2.3). Non-secret values only; secrets come from SecretProvider files.
// Hand-rolled instead of @fb/platform/config.loadConfig: that one needs a TypeBox schema, and booking may not
// depend on typebox directly (A-01 §1.2 booking-allowed: contracts + platform only).
import { parseBind, parseCidrList } from '@fb/platform/fastify';

export interface BookingConfig {
  /** listen address, e.g. 172.30.3.30:8083 (bk network interface only) */
  readonly bind: string;
  /** peers allowed to connect: gateway only, 172.30.3.20/32 */
  readonly allowedPeers: readonly string[];
  readonly pgHost: string;
  readonly pgPort: number;
  readonly pgDatabase: string;
  readonly pgUser: string;
  readonly logLevel: string;
}

export const CONFIG_KEYS = [
  'BOOKING_BIND',
  'BOOKING_ALLOWED_PEERS',
  'PG_HOST',
  'PG_PORT',
  'PG_DATABASE',
  'PG_USER',
  'LOG_LEVEL',
] as const;

export class BookingConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid booking configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'BookingConfigError';
    this.issues = issues;
  }
}

/** Every problem is listed by key; values are never echoed (a mis-keyed secret must not reach the error text). */
export function loadBookingConfig(env: Readonly<Record<string, string | undefined>> = process.env): BookingConfig {
  const issues: string[] = [];
  const str = (key: (typeof CONFIG_KEYS)[number], fallback?: string): string => {
    const v = env[key]?.trim();
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    issues.push(`${key}: required`);
    return '';
  };

  const bind = str('BOOKING_BIND');
  if (bind !== '') {
    try {
      parseBind(bind);
    } catch {
      issues.push('BOOKING_BIND: must be a concrete interface host:port (no wildcard)');
    }
  }
  const allowedPeers = str('BOOKING_ALLOWED_PEERS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedPeers.length > 0) {
    try {
      parseCidrList(allowedPeers);
    } catch {
      issues.push('BOOKING_ALLOWED_PEERS: must be a comma-separated list of IPs / CIDRs');
    }
  }
  const pgPortRaw = str('PG_PORT', '5432');
  const pgPort = Number(pgPortRaw);
  if (!/^\d{1,5}$/.test(pgPortRaw) || pgPort < 1 || pgPort > 65535) issues.push('PG_PORT: must be 1..65535');

  const config: BookingConfig = {
    bind,
    allowedPeers,
    pgHost: str('PG_HOST'),
    pgPort,
    pgDatabase: str('PG_DATABASE'),
    pgUser: str('PG_USER'),
    logLevel: str('LOG_LEVEL', 'info'),
  };
  if (issues.length > 0) throw new BookingConfigError(issues);
  return config;
}

/** SecretProvider mapping for booking (A-01 §2.3 matrix: pg_booking_password + booking_service_token). */
export const BOOKING_SECRET_FILES = {
  pg_password: 'pg_booking_password',
  booking_service_token: 'booking_service_token',
} as const;
