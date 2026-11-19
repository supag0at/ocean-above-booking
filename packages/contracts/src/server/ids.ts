// ID generation (A-01 §1.2, §3.2): prefix + 26 random Crockford base32 chars from node:crypto.
// Not time-sortable on purpose (O-7): no ULID.
import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet: no I, L, O, U. Matches the SQL CHECK `[0-9A-HJKMNP-TV-Z]`. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ID_BODY_LENGTH = 26;

// TODO(T01-REVIEW): A-01 §3.2 only fixes the `q_` and `t_` prefixes (SQL CHECKs). `run_` comes from
// A-02 §3.4 ("run_" + ULID; A-02 §16 table row 2) - here it is the same 26-char random body, not a ULID.
// No prefix is specified for memoryId (MemoryView); compactionId (`cmp_` + boundaryRunId) is derived, not random.
export const ID_PREFIX = {
  quote: 'q_',
  ticket: 't_',
  run: 'run_',
} as const;
export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** Prefix + 26 random Crockford base32 characters. A 5-bit mask on random bytes is unbiased (32 symbols). */
export function newId(prefix: string): string {
  if (!/^[a-z]+_$/.test(prefix)) throw new Error(`invalid id prefix: ${JSON.stringify(prefix)}`);
  const bytes = randomBytes(ID_BODY_LENGTH);
  let body = '';
  for (const b of bytes) body += CROCKFORD_ALPHABET.charAt(b & 31);
  return prefix + body;
}

export const newQuoteId = (): string => newId(ID_PREFIX.quote);
export const newTicketId = (): string => newId(ID_PREFIX.ticket);
export const newRunId = (): string => newId(ID_PREFIX.run);

/** Regex source (anchored) for a prefixed id; shared by schemas and tests. */
export const idPattern = (prefix: string): string => `^${prefix}[0-9A-HJKMNP-TV-Z]{${ID_BODY_LENGTH}}$`;

/** Ticket number: 'OA-' + last 8 chars of the ticket id body (A-01 §5.2). */
export function ticketNoFromId(ticketId: string): string {
  if (!new RegExp(idPattern(ID_PREFIX.ticket)).test(ticketId)) throw new Error('invalid ticket id');
  return `OA-${ticketId.slice(-8)}`;
}
