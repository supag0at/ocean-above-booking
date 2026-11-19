import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSecretProvider, SecretError } from '../src/secrets/index.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fb-secrets-'));
  writeFileSync(join(dir, 'cookie_secret'), 's3cr3t-value\n');
  writeFileSync(join(dir, 'pg_hands_password'), 'pw\r\n');
  writeFileSync(join(dir, 'harness_service_token'), '\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('FileSecretProvider', () => {
  it('reads <dir>/<name> and strips the trailing newline', () => {
    const p = new FileSecretProvider({ dir });
    expect(p.get('cookie_secret')).toBe('s3cr3t-value');
  });

  it('maps internal names to file names and strips CRLF', () => {
    const p = new FileSecretProvider({ dir, files: { pg_password: 'pg_hands_password' } });
    expect(p.get('pg_password')).toBe('pw');
  });

  it('caches: later file changes are not picked up', () => {
    const p = new FileSecretProvider({ dir });
    expect(p.get('cookie_secret')).toBe('s3cr3t-value');
    writeFileSync(join(dir, 'cookie_secret'), 'changed\n');
    expect(p.get('cookie_secret')).toBe('s3cr3t-value');
    writeFileSync(join(dir, 'cookie_secret'), 's3cr3t-value\n');
  });

  it('missing file -> SecretError naming the secret and path', () => {
    const p = new FileSecretProvider({ dir });
    expect(() => p.get('deepseek_api_key')).toThrow(SecretError);
    expect(() => p.get('deepseek_api_key')).toThrow(/deepseek_api_key.*ENOENT/);
  });

  it('preload makes a missing file fail at construction (startup)', () => {
    expect(() => new FileSecretProvider({ dir, preload: ['redis_password'] })).toThrow(/redis_password/);
  });

  it('empty secret is an error', () => {
    expect(() => new FileSecretProvider({ dir }).get('harness_service_token')).toThrow(/empty/);
  });

  it('rejects path traversal in the file mapping', () => {
    const p = new FileSecretProvider({ dir, files: { cookie_secret: '../x' } });
    expect(() => p.get('cookie_secret')).toThrow(SecretError);
  });

  it('values() exposes what has been read (for log redaction)', () => {
    const p = new FileSecretProvider({ dir });
    p.get('cookie_secret');
    expect(p.values()).toEqual(['s3cr3t-value']);
  });
});

describe('no secrets from process.env', () => {
  const srcRoot = join(import.meta.dirname, '..', 'src');
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const ENV_READ = /process\s*\.\s*env|process\s*\[\s*['"]env['"]\s*\]/;

  it('only the config sub-entry (non-secret config, injectable env) mentions process.env', () => {
    const offenders = files(srcRoot)
      .filter((f) => ENV_READ.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(srcRoot.length + 1).replace(/\\/g, '/'));
    expect(offenders).toEqual(['config/index.ts']);
  });

  it('secrets, pg, redis, http, fastify, log and trace never touch process.env', () => {
    for (const sub of ['secrets', 'pg', 'redis', 'http', 'fastify', 'log', 'trace']) {
      for (const f of files(join(srcRoot, sub))) {
        expect(ENV_READ.test(readFileSync(f, 'utf8')), f).toBe(false);
      }
    }
  });
});
