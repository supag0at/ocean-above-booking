// @fb/platform/log: pino factory with redaction (A-01 §8).
// Never logged: cookies, tokens, API keys, Authorization, anything SecretProvider returned,
// user message text, LLM text. Path redaction handles known field names; a stream scrubber handles
// values (DeepSeek-key shaped strings and registered secret values) wherever they appear.
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export const REDACT_CENSOR = '[Redacted]';

/** field names that must never reach the log */
const SENSITIVE_KEYS = [
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-csrf-token',
  'x-lease-fence',
  'password',
  'passwd',
  'secret',
  'token',
  'accessToken',
  'handsToken',
  'serviceToken',
  'csrf',
  'apiKey',
  'api_key',
  'privateKey',
  'signingKey',
  'cookieSecret',
  'deepseek_api_key',
  // user / LLM text (A-01 §8: log lengths or hashes instead)
  // TODO(T02-REVIEW): the final list of content field names depends on log conventions in T06/T09.
  'userMessage',
  'llmText',
  'messageText',
];

const isIdent = (k: string): boolean => /^[A-Za-z_$][\w$]*$/.test(k);
const seg = (prefix: string, k: string): string => {
  if (isIdent(k)) return prefix === '' ? k : `${prefix}.${k}`;
  return `${prefix}["${k}"]`;
};

function buildPaths(): string[] {
  const out: string[] = [];
  for (const prefix of ['', '*', '*.*']) {
    for (const k of SENSITIVE_KEYS) out.push(seg(prefix, k));
  }
  for (const holder of ['req.headers', 'res.headers', 'headers', 'request.headers', 'response.headers']) {
    for (const k of SENSITIVE_KEYS) out.push(seg(holder, k));
  }
  return [...new Set(out)];
}

export const REDACT_PATHS: readonly string[] = buildPaths();

/** DeepSeek API key shape (sk-...); also catches OpenAI-style keys. */
const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g;
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export interface LogSink {
  write(line: string): void;
}

/**
 * Wraps a sink and masks secret-looking values in every serialized log line.
 * `secretValues` is evaluated per line so secrets loaded later are still covered.
 */
export function createScrubbingSink(sink: LogSink, secretValues?: () => Iterable<string>): LogSink {
  return {
    write(line: string): void {
      let out = line.replace(KEY_PATTERN, REDACT_CENSOR).replace(BEARER_PATTERN, `$1 ${REDACT_CENSOR}`);
      if (secretValues) {
        for (const v of secretValues()) {
          if (v.length < 4) continue; // too short to mask without shredding the log
          const escaped = JSON.stringify(v).slice(1, -1);
          out = out.split(v).join(REDACT_CENSOR);
          if (escaped !== v) out = out.split(escaped).join(REDACT_CENSOR);
        }
      }
      sink.write(out);
    },
  };
}

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level?: string;
  /** where lines go; default process.stdout */
  readonly destination?: LogSink;
  /** values of secrets read via SecretProvider (e.g. () => fileSecretProvider.values()) */
  readonly secretValues?: () => Iterable<string>;
  /** extra fields on every line */
  readonly base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const sink = createScrubbingSink(options.destination ?? process.stdout, options.secretValues);
  const loggerOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, ...options.base },
    // fixed fields per A-01 §8: ts, level, service, ..., msg
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  };
  return pino(loggerOptions, sink as DestinationStream);
}
