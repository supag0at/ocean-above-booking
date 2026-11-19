import { describe, expect, it } from 'vitest';
import { formatKm, formatUsdCents } from '../src/web/index.ts';

describe('formatUsdCents (M-13, D-09)', () => {
  it('formats integer cents to 0.01 USD without symbol or grouping', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(formatUsdCents(0, locale)).toBe('0.00');
      expect(formatUsdCents(1, locale)).toBe('0.01');
      expect(formatUsdCents(9, locale)).toBe('0.09');
      expect(formatUsdCents(10, locale)).toBe('0.10');
      expect(formatUsdCents(99, locale)).toBe('0.99');
      expect(formatUsdCents(100, locale)).toBe('1.00');
      expect(formatUsdCents(234000, locale)).toBe('2340.00');
      expect(formatUsdCents(1234567, locale)).toBe('12345.67');
    }
  });
  it('rejects anything that is not a non-negative safe integer (it never rounds or computes)', () => {
    expect(() => formatUsdCents(1.5, 'en')).toThrow(RangeError);
    expect(() => formatUsdCents(-1, 'en')).toThrow(RangeError);
    expect(() => formatUsdCents(Number.NaN, 'en')).toThrow(RangeError);
    expect(() => formatUsdCents(Number.POSITIVE_INFINITY, 'en')).toThrow(RangeError);
  });
});

describe('formatKm (M-13, D-09)', () => {
  it('keeps exactly 2 decimals', () => {
    expect(formatKm(0, 'en')).toBe('0.00');
    expect(formatKm(18000, 'zh')).toBe('18000.00');
    expect(formatKm(8123.4567891, 'en')).toBe('8123.46');
    expect(formatKm(120.954, 'en')).toBe('120.95');
    expect(formatKm(120.956, 'en')).toBe('120.96');
    expect(formatKm(0.004, 'en')).toBe('0.00');
    expect(formatKm(0.005001, 'en')).toBe('0.01');
    expect(formatKm(307.21, 'en')).toBe('307.21');
  });
  it('rejects non-finite or negative values', () => {
    expect(() => formatKm(-0.5, 'en')).toThrow(RangeError);
    expect(() => formatKm(Number.NaN, 'en')).toThrow(RangeError);
    expect(() => formatKm(Number.POSITIVE_INFINITY, 'zh')).toThrow(RangeError);
  });
});
