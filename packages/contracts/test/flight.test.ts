import { describe, expect, it } from 'vitest';
import {
  COMPACT_HIGH,
  COMPACT_LOW,
  COMPACT_MAX_QUOTES,
  LOCATIONS_DB_SHA256,
  MAX_TOKENS,
  MODEL_ID,
  PRICE_CENTS_PER_KM,
  PRICE_PER_KM_USD,
  RUN_LIMITS,
  TIE_BREAK_ORDER,
  TRANSLITERATION_TABLE,
  type Route,
} from '../src/flight/index.ts';
import * as flightModule from '../src/flight/index.ts';
import type { Quote } from '../src/web/index.ts';

describe('flight constants (CONTRACT-v1 §3)', () => {
  it('match the contract values', () => {
    expect(PRICE_PER_KM_USD).toBe(0.13);
    expect(PRICE_CENTS_PER_KM).toBe(PRICE_PER_KM_USD * 100);
    expect(LOCATIONS_DB_SHA256).toBe('fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f');
    expect(MAX_TOKENS).toBe(4096);
    expect([COMPACT_HIGH, COMPACT_LOW, COMPACT_MAX_QUOTES]).toEqual([40000, 16000, 20]);
    expect(MODEL_ID).toBe('deepseek-flash');
    expect(RUN_LIMITS).toEqual({
      maxTurns: 8,
      maxToolCalls: 12,
      requestTimeoutMs: 60000,
      runTimeoutMs: 120000,
      restartLimit: 3,
    });
    expect(TIE_BREAK_ORDER).toEqual(['totalDistance', 'legCount', 'citySequenceCodePointLex']);
  });

  it('transliteration table contains the required letters', () => {
    const required: Record<string, string> = {
      ø: 'o',
      Ø: 'O',
      ł: 'l',
      Ł: 'L',
      æ: 'ae',
      Æ: 'AE',
      ß: 'ss',
      đ: 'd',
      Đ: 'D',
      þ: 'th',
      œ: 'oe',
    };
    for (const [k, v] of Object.entries(required)) expect(TRANSLITERATION_TABLE[k]).toBe(v);
  });

  it('every table key is a letter NFKD cannot decompose', () => {
    for (const k of Object.keys(TRANSLITERATION_TABLE)) {
      expect(k.normalize('NFKD').replace(/\p{M}/gu, '')).toBe(k);
    }
  });
});

describe('M-19 transliteration additions', () => {
  it('has the A-02 extras and the capitals Ð, Ħ, Þ', () => {
    const extra: Record<string, string> = { Œ: 'OE', ð: 'd', ı: 'i', ħ: 'h', Ð: 'D', Ħ: 'H', Þ: 'TH' };
    for (const [k, v] of Object.entries(extra)) expect(TRANSLITERATION_TABLE[k]).toBe(v);
  });
  it('capital and small forms agree after lowercasing', () => {
    for (const [cap, small] of [
      ['Ð', 'ð'],
      ['Ħ', 'ħ'],
      ['Þ', 'þ'],
      ['Œ', 'œ'],
    ] as const) {
      expect(TRANSLITERATION_TABLE[cap]?.toLowerCase()).toBe(TRANSLITERATION_TABLE[small]);
    }
  });
});

describe('M-12 Route is derived from the web Quote', () => {
  it('a Route plus quoteId/dataSha256/createdAt is a web Quote (type-level check)', () => {
    const route: Route = {
      from: 'A',
      to: 'B',
      legs: [{ from: 'A', to: 'B', distanceKm: 1 }],
      transferCities: [],
      totalDistanceKm: 1,
      priceCents: 13,
      display: { legs: ['1.00'], totalDistanceKm: '1.00', priceUsd: '0.13' },
    };
    const quote: Quote = { ...route, quoteId: 'q_x', dataSha256: LOCATIONS_DB_SHA256, createdAt: 't' };
    expect(quote.priceCents).toBe(route.priceCents);
    expect('Quote' in flightModule).toBe(false);
  });
});
