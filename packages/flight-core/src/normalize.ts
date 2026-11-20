// norm(s): A-02 §7.1 pipeline (CONTRACT-v1 §3, transliteration table from @fb/contracts/flight, M-19).
import { TRANSLITERATION_TABLE, ZERO_WIDTH_CHARS_PATTERN } from '@fb/contracts/flight';

const ZERO_WIDTH = new RegExp(ZERO_WIDTH_CHARS_PATTERN, 'gu');
const COMBINING = /\p{M}/gu;
const APOSTROPHE_PERIOD = /['’.]/gu;
const NON_ALNUM = /[^0-9a-z]+/gu;

function transliterate(s: string): string {
  let out = '';
  for (const ch of s) out += TRANSLITERATION_TABLE[ch] ?? ch;
  return out;
}

/**
 * 1. NFKC, strip zero-width; 2. transliteration table; 3. NFKD, strip combining marks, lowercase;
 * 4. drop apostrophes and periods; 5. other non [0-9a-z] -> space, collapse, trim.
 */
export function normalize(s: string): string {
  const step1 = s.normalize('NFKC').replace(ZERO_WIDTH, '');
  const step2 = transliterate(step1);
  const step3 = step2.normalize('NFKD').replace(COMBINING, '').toLowerCase();
  const step4 = step3.replace(APOSTROPHE_PERIOD, '');
  return step4.replace(NON_ALNUM, ' ').trim();
}

/** Compare two strings by Unicode code point (M-22: not localeCompare, not UTF-16 units). */
export function compareCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
