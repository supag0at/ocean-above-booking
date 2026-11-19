// @fb/platform/config: non-secret configuration loading and validation (A-01 §2.3, §2.4).
// The schema is a TypeBox object; only the declared keys are picked from the environment, strings
// are converted to the declared types, and any problem aborts startup with a message that lists every
// offending key (never its value: a mistakenly mis-keyed secret must not end up in the error text).
import type { Static, TObject, TProperties } from 'typebox';
import { Value } from 'typebox/value';

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Keys that look like secrets may only be paths to files (`*_FILE`); secrets never live in the environment (A-01 §2.3). */
const SECRET_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)/i;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function loadConfig<T extends TProperties>(
  schema: TObject<T>,
  env: EnvSource = process.env,
): Static<TObject<T>> {
  const issues: string[] = [];
  const keys = Object.keys(schema.properties);

  for (const key of keys) {
    if (SECRET_KEY.test(key) && !/_FILE$/.test(key)) {
      issues.push(`${key}: secret-looking key is not allowed in configuration (use SecretProvider)`);
    }
  }

  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const v = env[key];
    if (v !== undefined && v !== '') picked[key] = v;
  }

  // defaults first (missing keys), then string -> declared type conversion
  const converted = Value.Convert(schema, Value.Default(schema, picked));
  for (const e of Value.Errors(schema, converted)) {
    const path = e.instancePath === '' ? '(root)' : e.instancePath.replace(/^\//, '').replace(/\//g, '.');
    // some validators report required keys on the parent path; keep the message, drop the value
    issues.push(`${path}: ${e.message}`);
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return converted as Static<TObject<T>>;
}
