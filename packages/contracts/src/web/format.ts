// Display formatting for values the API has ALREADY computed (M-13, D-09). Pure string functions:
// no price calculation, no Intl (A-01 §9: numbers are shown as the server formats them), so the output
// is identical in every runtime and matches `Quote.display` (e.g. "2340.00", "18000.00").
import type { Locale } from './views.ts';

/** Decimal separator per UI locale. Both supported locales use '.', and neither groups digits. */
const DECIMAL_SEPARATOR: Readonly<Record<Locale, string>> = { zh: '.', en: '.' };

/** `18000` -> "18000.00". Distance is rounded to 2 decimals (D-09). */
export function formatKm(km: number, locale: Locale): string {
  if (!Number.isFinite(km) || km < 0) throw new RangeError(`formatKm: expected a finite number >= 0, got ${km}`);
  return withSeparator(km.toFixed(2), locale);
}

/** `234000` -> "2340.00". Integer cents are shown to 0.01 USD (D-09); no currency symbol. */
export function formatUsdCents(cents: number, locale: Locale): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`formatUsdCents: expected a non-negative integer, got ${cents}`);
  }
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return withSeparator(`${whole}.${frac}`, locale);
}

function withSeparator(fixed: string, locale: Locale): string {
  return fixed.replace('.', DECIMAL_SEPARATOR[locale]);
}
