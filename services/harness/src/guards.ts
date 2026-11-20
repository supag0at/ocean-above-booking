// Final-reply guards (A-02 §8.4–§8.6). Pure functions.
// §8.7 masking is VOID (CONTRACT M-2: "不需要打码"); only the guards on persisted assistant text remain.
import { ZERO_WIDTH_CHARS_PATTERN } from '@fb/contracts/flight';
import { isType, ofType, type Ev } from './events.ts';
import { parseMessage } from './projector.ts';
import { renderRunContext } from './render.ts';

const ZW = new RegExp(ZERO_WIDTH_CHARS_PATTERN, 'g');
export const normText = (t: string): string => t.replace(ZW, '').normalize('NFKC').replace(ZW, '');

// ---- preprocessing (§8.4) ----
const ID_RES = [/\b[qt]_[0-9A-HJKMNP-TV-Z]{26}\b/g, /\bOA-[0-9A-Z]{8}\b/g, /\b(?:run|call)_[A-Za-z0-9_]+\b/g];
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?/g,
  /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
];
/** Replace ids and dates with spaces of the same length so offsets (context windows) stay meaningful. */
export function preprocess(text: string): string {
  let t = normText(text);
  for (const re of [...ID_RES, ...DATE_RES]) t = t.replace(re, (m) => ' '.repeat(m.length));
  return t;
}

// ---- extraction ----
const NUM_RE = /\d{1,3}(?:[,\u00A0 ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export interface ExtractedNumber {
  readonly raw: string;
  /** normalised value, 2 decimals */
  readonly value: string;
  readonly hasDecimal: boolean;
  readonly numeric: number;
  readonly start: number;
  readonly end: number;
}

export function extractNumbers(preprocessed: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of preprocessed.matchAll(NUM_RE)) {
    const start = m.index;
    let end = start + m[0].length;
    let n = Number(m[0].replace(/[,\u00A0 ]/g, ''));
    const suffix = preprocessed.slice(end).match(/^\s?(万|k|K)(?![A-Za-z])/);
    if (suffix) {
      n *= suffix[1] === '万' ? 10000 : 1000;
      end += suffix[0].length;
    }
    if (!Number.isFinite(n)) continue;
    out.push({
      raw: preprocessed.slice(start, end),
      value: n.toFixed(2),
      hasDecimal: m[0].includes('.'),
      numeric: n,
      start,
      end,
    });
  }
  return out;
}

/** Normalise any value (number or numeric string as shown) to the 2-decimal form used by the allow sets. */
export function normValue(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,\u00A0 ]/g, ''));
    if (v.trim() !== '' && Number.isFinite(n)) return n.toFixed(2);
  }
  return undefined;
}

// ---- classification ----
const PRICE_WORDS = [
  'US$',
  'USD',
  '$',
  '美元',
  '美金',
  '刀',
  'dollar',
  'price',
  '价格',
  '票价',
  '费用',
  'fare',
  'cost',
];
const DIST_WORDS = ['km', '公里', '千米', 'kilometer', '距离', '里程', 'distance'];
const WINDOW = 16;

/** Distance (in chars) from the number to the nearest occurrence of any word inside the ±16-char window, or Infinity. */
function nearest(text: string, start: number, end: number, words: readonly string[]): number {
  const lo = Math.max(0, start - WINDOW);
  const hi = Math.min(text.length, end + WINDOW);
  const before = text.slice(lo, start).toLowerCase();
  const after = text.slice(end, hi).toLowerCase();
  let best = Number.POSITIVE_INFINITY;
  for (const w0 of words) {
    const w = w0.toLowerCase();
    const bi = before.lastIndexOf(w);
    if (bi >= 0) best = Math.min(best, before.length - (bi + w.length));
    const ai = after.indexOf(w);
    if (ai >= 0) best = Math.min(best, ai);
  }
  return best;
}

export type NumberContext = 'price' | 'distance' | 'both' | 'none';

/**
 * CONTRACT M-23 ①: a number near both a price word and a distance word belongs to the NEARER word; at equal distance
 * ('both') it passes if it is in EITHER the price or the distance set.
 */
export function classify(text: string, n: ExtractedNumber): NumberContext {
  const p = nearest(text, n.start, n.end, PRICE_WORDS);
  const d = nearest(text, n.start, n.end, DIST_WORDS);
  if (p === Number.POSITIVE_INFINITY && d === Number.POSITIVE_INFINITY) return 'none';
  if (p < d) return 'price';
  if (d < p) return 'distance';
  return 'both';
}

// ---- allow sets (§8.4) ----
export interface AllowSets {
  readonly price: ReadonlySet<string>;
  readonly dist: ReadonlySet<string>;
  readonly sys: ReadonlySet<string>;
}

function walk(
  v: unknown,
  visit: (key: string, value: unknown, parentKey: string | undefined) => void,
  parent?: string,
): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit, parent);
    return;
  }
  if (v === null || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    visit(k, x, parent);
    walk(x, visit, k);
  }
}

function collectDisplay(data: unknown, price: Set<string>, dist: Set<string>): void {
  walk(data, (key, value, parent) => {
    if (parent === 'display') {
      if (key === 'priceUsd') add(price, value);
      if (key === 'totalDistanceKm') add(dist, value);
      if (key === 'legs' && Array.isArray(value)) for (const l of value) add(dist, l);
    }
    if (parent === 'nearestServed' && key === 'distanceKm') add(dist, value);
  });
}
function add(set: Set<string>, v: unknown): void {
  const n = normValue(v);
  if (n !== undefined) set.add(n);
}
function addAllFromText(set: Set<string>, text: string): void {
  for (const n of extractNumbers(preprocess(text))) set.add(n.value);
}

/**
 * Session-wide allow sets: every tool result `data` and booking payload in the whole log (not just the current run),
 * plus numbers from tool-result llmText and run_context. Numbers from user.message NEVER enter (H-01).
 */
export function allowSets(events: readonly Ev[]): AllowSets {
  const price = new Set<string>();
  const dist = new Set<string>();
  const sysExtra = new Set<string>();
  for (const e of events) {
    if (isType(e, 'agent.message') && e.payload.role === 'toolResult') {
      collectDisplay(e.payload.data, price, dist);
      const m = parseMessage(e);
      if (m.role === 'toolResult') {
        for (const c of m.content) if (c.type === 'text') addAllFromText(sysExtra, c.text);
      }
    } else if (isType(e, 'booking.confirmed') || isType(e, 'booking.failed')) {
      collectDisplay(e.payload, price, dist);
    } else if (isType(e, 'agent.run_started')) {
      addAllFromText(sysExtra, renderRunContext(e.payload));
    }
  }
  const sys = new Set<string>([...price, ...dist, ...sysExtra]);
  return { price, dist, sys };
}

const CN_NUM = /[零〇一二两三四五六七八九十百千万亿]+/g;

export interface GuardHit {
  readonly guard: 'number' | 'booking_claim' | 'tag';
  readonly offending: string[];
}

/** §8.4 number guard. Returns offending numbers in 2-decimal form, Chinese numerals verbatim (empty = pass). */
export function numberGuard(text: string, sets: AllowSets): string[] {
  const t = preprocess(text);
  const bad: string[] = [];
  const nums = extractNumbers(t);
  // Arabic numbers (with their 万/k suffix) are blanked before the Chinese-numeral scan, so "1.8万" counts once
  let rest = t;
  for (const n of nums) rest = rest.slice(0, n.start) + ' '.repeat(n.end - n.start) + rest.slice(n.end);
  for (const n of nums) {
    const ctx = classify(t, n);
    const inPrice = sets.price.has(n.value);
    const inDist = sets.dist.has(n.value);
    let ok: boolean;
    if (ctx === 'price') ok = inPrice;
    else if (ctx === 'distance') ok = inDist;
    else if (ctx === 'both') ok = inPrice || inDist;
    else ok = !(n.hasDecimal || n.numeric >= 100) || sets.sys.has(n.value);
    if (!ok) bad.push(n.value);
  }
  // Chinese numerals within 4 chars of a price/distance word: cannot be verified -> always a violation.
  for (const m of rest.matchAll(CN_NUM)) {
    const lo = Math.max(0, m.index - 4);
    const around = rest.slice(lo, m.index + m[0].length + 4).toLowerCase();
    if ([...PRICE_WORDS, ...DIST_WORDS].some((w) => around.includes(w.toLowerCase()))) bad.push(m[0]);
  }
  return bad;
}

// §8.5 (harness-local table: the contract package does not carry it yet, see T09 report)
export const BOOKING_CLAIM_RE =
  /已(?:为您|帮您|给您)?(?:预订|订好|订票成功|出票|完成预订|搞定)|座位已(?:经)?(?:为您)?(?:留好|锁定)|booked (?:it|your|the)|booking (?:is |has been )?confirmed|ticket (?:has been |is )?issued|you'?re all set/gi;

export function bookingClaimGuard(text: string, hasBookingConfirmed: boolean): string[] {
  if (hasBookingConfirmed) return [];
  return [...normText(text).matchAll(BOOKING_CLAIM_RE)].map((m) => m[0]);
}

// §8.6
const TAG_RE = /<\s*\/?\s*(?:system_event|run_context)\b/gi;
export function tagGuard(text: string): string[] {
  return [...normText(text).matchAll(TAG_RE)].map((m) => m[0]);
}

/** Has any booking.confirmed been written before `beforeSeq`? (the projection's view, including folded runs) */
export function hasBookingConfirmed(events: readonly Ev[], beforeSeq: number): boolean {
  return ofType(events, 'booking.confirmed').some((e) => e.seq < beforeSeq);
}

/** Guards for a final-reply candidate (stop message), in order tag → number → booking_claim. */
export function checkFinalReply(text: string, sets: AllowSets, booked: boolean): GuardHit | undefined {
  const tag = tagGuard(text);
  if (tag.length > 0) return { guard: 'tag', offending: tag };
  const num = numberGuard(text, sets);
  if (num.length > 0) return { guard: 'number', offending: num };
  const claim = bookingClaimGuard(text, booked);
  if (claim.length > 0) return { guard: 'booking_claim', offending: claim };
  return undefined;
}
