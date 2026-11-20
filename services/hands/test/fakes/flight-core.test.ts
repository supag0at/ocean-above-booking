import { describe, expect, it } from 'vitest';
import { createFakeFlightCore } from './flight-core.ts';

const core = createFakeFlightCore();

describe('fake flight-core', () => {
  it('normalizes', () => {
    expect(core.normalize('São Paulo')).toBe('sao paulo');
    expect(core.normalize('Tromsø')).toBe('tromso');
    expect(core.normalize("Xi'an")).toBe('xian');
    expect(core.normalize("St. John's")).toBe('st johns');
    expect(core.normalize('Washington, D.C.')).toBe('washington dc');
    expect(core.normalize('ＳＡＯ　ＰＡＵＬＯ')).toBe('sao paulo');
  });

  it('quotes Shanghai to São Paulo', () => {
    const r = core.quoteRoute('Shanghai', 'São Paulo');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.legs).toEqual([
      { from: 'Shanghai', to: 'Dubai', distanceKm: 5000 },
      { from: 'Dubai', to: 'São Paulo', distanceKm: 6000 },
    ]);
    expect(r.route.transferCities).toEqual(['Dubai']);
    expect(r.route.totalDistanceKm).toBe(11000);
    expect(r.route.priceCents).toBe(143000);
    expect(r.route.display.priceUsd).toBe('1430.00');
  });

  it('reports route errors', () => {
    expect(core.quoteRoute('Shanghai', 'Reykjavik')).toEqual({ ok: false, code: 'NO_ROUTE' });
    expect(core.quoteRoute('Shanghai', 'Shanghai')).toEqual({ ok: false, code: 'SAME_CITY' });
    expect(core.quoteRoute('shanghai', 'Dubai')).toEqual({ ok: false, code: 'CITY_NOT_FOUND' });
    expect(core.quoteRoute('Austin', 'Shanghai')).toEqual({
      ok: false,
      code: 'CITY_NOT_SERVED',
      nearestServed: { city: 'Copenhagen', distanceKm: '120.00' },
    });
  });

  it('computes nearestServed', () => {
    expect(core.nearestServed('Austin')).toEqual({ city: 'Copenhagen', distanceKm: '120.00' });
    expect(core.nearestServed('Shanghai')).toBeNull();
  });

  it('resolves cities', () => {
    const amb = core.resolveCity({ original: '圣何塞', candidates: ['San Jose'] });
    expect(amb.status).toBe('ambiguous');
    expect(amb.matches).toHaveLength(2);
    expect(amb.matchedBy).toEqual({ source: 'candidate', index: 0 });

    const ex = core.resolveCity({ original: 'x', candidates: ['Zurich'] });
    expect(ex.status).toBe('exact');
    expect(ex.matches.map((m) => m.city)).toEqual(['Zürich']);

    const sg = core.resolveCity({ original: 'x', candidates: ['Sao Paolo'] });
    expect(sg.status).toBe('suggest');
    expect(sg.matchedBy).toEqual({ source: 'fuzzy' });
    expect(sg.matches.map((m) => m.city)).toContain('São Paulo');

    const nf = core.resolveCity({ original: 'x', candidates: ['qqqqqq'] });
    expect(nf).toEqual({ status: 'not_found', matches: [] });

    const au = core.resolveCity({ original: 'Austin', candidates: [] });
    expect(au.matches[0]?.nearestServed?.city).toBe('Copenhagen');
  });
});
