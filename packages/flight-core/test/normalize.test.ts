import { describe, expect, it } from 'vitest';
import { compareCodePoint, normalize } from '../src/normalize.ts';
import { ALL_NAMES } from './helpers.ts';

describe('normalize (A-02 §7.1 pipeline)', () => {
  it.each([
    ['São Paulo', 'sao paulo'],
    ['Zürich', 'zurich'],
    ['ZURICH', 'zurich'],
    ['Tromsø', 'tromso'],
    ['TROMSØ', 'tromso'],
    ['Wrocław', 'wroclaw'],
    ['WROCŁAW', 'wroclaw'],
    ['Æble', 'aeble'],
    ['Straße', 'strasse'],
    ['Œuvre', 'oeuvre'],
    ['Đakovo', 'dakovo'],
    ['Þórshöfn', 'thorshofn'],
    ['Ħamrun', 'hamrun'],
    ['Diyarbakır', 'diyarbakir'],
    ["Xi'an", 'xian'],
    ['Xi’an', 'xian'],
    ["St. John's", 'st johns'],
    ['Washington, D.C.', 'washington dc'],
    ['  New   York  ', 'new york'],
    ['Ｓｈａｎｇｈａｉ', 'shanghai'], // full-width (NFKC)
    ['Shang​hai', 'shanghai'], // zero-width space
    ['﻿Paris⁠', 'paris'],
    ['Saint-Étienne', 'saint etienne'],
    ['上海', ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it('every city name normalises to non-empty ASCII [0-9a-z ]', () => {
    for (const n of ALL_NAMES) expect(normalize(n)).toMatch(/^[0-9a-z]+( [0-9a-z]+)*$/u);
  });

  it('the collision set is exactly {San Jose, San José} (detects data changes)', () => {
    const byNorm = new Map<string, string[]>();
    for (const n of ALL_NAMES) byNorm.set(normalize(n), [...(byNorm.get(normalize(n)) ?? []), n]);
    const collisions = [...byNorm.values()].filter((v) => v.length > 1);
    expect(collisions).toHaveLength(1);
    expect(new Set(collisions[0])).toEqual(new Set(['San Jose', 'San José']));
  });

  it('is idempotent', () => {
    for (const n of ALL_NAMES) expect(normalize(normalize(n))).toBe(normalize(n));
  });
});

describe('compareCodePoint (M-22 ①)', () => {
  it('is case-sensitive code point order, not locale order', () => {
    expect(compareCodePoint('B', 'a')).toBeLessThan(0);
    expect(compareCodePoint('a', 'á')).toBeLessThan(0);
    expect(compareCodePoint('Zürich', 'Zurrieq')).toBeGreaterThan(0);
    expect(compareCodePoint('ab', 'abc')).toBeLessThan(0);
    expect(compareCodePoint('x', 'x')).toBe(0);
  });
  it('orders astral characters above BMP private-use (differs from UTF-16 unit order)', () => {
    expect(compareCodePoint('\u{1F600}', '�')).toBeGreaterThan(0);
    expect('\u{1F600}' < '�').toBe(true); // what a naive `<` would say
  });
});
