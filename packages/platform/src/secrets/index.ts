// @fb/platform/secrets: SecretProvider (A-01 §2.4). Secrets are files under /run/secrets/<name>
// (A-01 §2.3); this module never reads the process environment.
// TODO(T02-REVIEW): A-01 §2.4 also describes a dev-only EnvSecretProvider. The task brief forbids
// reading secrets from the environment, so it is NOT implemented; decide whether local Windows dev needs it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_NAMES = [
  'pg_password',
  'redis_password',
  'deepseek_api_key',
  'harness_service_token',
  'booking_service_token',
  'hands_token_signing_key',
  'cookie_secret',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface SecretProvider {
  get(name: SecretName): string;
}

export class SecretError extends Error {
  readonly secretName: string;
  constructor(secretName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecretError';
    this.secretName = secretName;
  }
}

export const DEFAULT_SECRETS_DIR = '/run/secrets';

export interface FileSecretProviderOptions {
  /** directory holding the secret files; default /run/secrets */
  readonly dir?: string;
  /** service-internal name -> file name (e.g. pg_password -> pg_hands_password); default identity */
  readonly files?: Partial<Readonly<Record<SecretName, string>>>;
  /** read these eagerly in the constructor so a missing file fails startup (A-01 §2.4) */
  readonly preload?: readonly SecretName[];
}

export class FileSecretProvider implements SecretProvider {
  private readonly dir: string;
  private readonly files: Partial<Readonly<Record<SecretName, string>>>;
  private readonly cache = new Map<SecretName, string>();

  constructor(options: FileSecretProviderOptions = {}) {
    this.dir = options.dir ?? DEFAULT_SECRETS_DIR;
    this.files = options.files ?? {};
    for (const name of options.preload ?? []) this.get(name);
  }

  get(name: SecretName): string {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    const fileName = this.files[name] ?? name;
    // guard against path traversal through a mis-written mapping
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      throw new SecretError(name, `invalid secret file name for "${name}"`);
    }
    const path = join(this.dir, fileName);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      throw new SecretError(name, `secret "${name}" cannot be read from ${path}${code ? ` (${code})` : ''}`, {
        cause,
      });
    }
    const value = raw.replace(/[\r\n]+$/, '');
    if (value.length === 0) throw new SecretError(name, `secret "${name}" at ${path} is empty`);
    this.cache.set(name, value);
    return value;
  }

  /** Values read so far; used to feed the log redactor (A-01 §2.4 test 3). */
  values(): string[] {
    return [...this.cache.values()];
  }
}
