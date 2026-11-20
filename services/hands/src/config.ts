// Non-secret hands configuration (A-01 §2.2, §2.3). Parsed by hand: hands has no typebox dependency (M-24).
// Secrets (pg password) come only from SecretProvider files; the token public key is a mounted config file.

export interface HandsConfig {
  readonly bind: string;
  readonly allowedPeers: readonly string[];
  readonly pgHost: string;
  readonly pgPort: number;
  readonly pgDatabase: string;
  readonly pgUser: string;
  readonly locationsDbPath: string;
  readonly publicKeyPaths: readonly string[];
  readonly logLevel: string;
}

export const HANDS_DEFAULTS = {
  HANDS_BIND: '172.30.2.30:8082',
  HANDS_ALLOWED_PEERS: '172.30.2.128/25',
  PG_PORT: '5432',
  PG_DATABASE: 'app',
  PG_USER: 'fb_hands',
  LOCATIONS_DB_PATH: '/data/locations.db',
  HANDS_VERIFY_KEY_PATHS: '/run/configs/hands_token_public_key.pem',
  LOG_LEVEL: 'info',
} as const;

export function loadHandsConfig(env: Readonly<Record<string, string | undefined>>): HandsConfig {
  const issues: string[] = [];
  const get = (k: string): string => {
    const v = env[k];
    if (v !== undefined && v !== '') return v;
    const d = (HANDS_DEFAULTS as Record<string, string>)[k];
    if (d === undefined) issues.push(`${k}: required`);
    return d ?? '';
  };
  const list = (k: string) =>
    get(k)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const port = Number(get('PG_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push('PG_PORT: must be a port number');
  const cfg: HandsConfig = {
    bind: get('HANDS_BIND'),
    allowedPeers: list('HANDS_ALLOWED_PEERS'),
    pgHost: get('PG_HOST'),
    pgPort: port,
    pgDatabase: get('PG_DATABASE'),
    pgUser: get('PG_USER'),
    locationsDbPath: get('LOCATIONS_DB_PATH'),
    publicKeyPaths: list('HANDS_VERIFY_KEY_PATHS'),
    logLevel: get('LOG_LEVEL'),
  };
  if (cfg.allowedPeers.length === 0) issues.push('HANDS_ALLOWED_PEERS: empty');
  if (cfg.publicKeyPaths.length === 0) issues.push('HANDS_VERIFY_KEY_PATHS: empty');
  if (issues.length > 0) throw new Error(`invalid hands configuration:\n  - ${issues.join('\n  - ')}`);
  return cfg;
}
