import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { recallPreferences } from '../src/index.ts';
import type { MemoryRow } from '../src/index.ts';

const U = 'u1';
let n = 0;
function row(p: Partial<MemoryRow> & Pick<MemoryRow, 'key' | 'value' | 'createdAt'>): MemoryRow {
  n += 1;
  return { id: `m_${String(n).padStart(4, '0')}`, userId: U, sourceSessionId: 's1', sourceSeq: 1, ...p };
}

describe('recallPreferences (A-01 §3.2, A-02 §9.3)', () => {
  it('latest row wins per key', () => {
    const a = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const b = row({ key: 'home_city', value: 'Tokyo', createdAt: '2026-01-02T00:00:00Z' });
    expect(recallPreferences(U, [a, b], []).home_city?.value).toBe('Tokyo');
    expect(recallPreferences(U, [b, a], []).home_city?.value).toBe('Tokyo');
  });

  it('acceptance: save Shanghai, save Tokyo, delete Tokyo => home_city absent (no fallback)', () => {
    const a = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const b = row({ key: 'home_city', value: 'Tokyo', createdAt: '2026-01-02T00:00:00Z' });
    const r = recallPreferences(U, [a, b], [{ memoryId: b.id, userId: U }]);
    expect(r.home_city).toBeUndefined();
  });

  it('tombstone (value null) as latest row => key absent, older value does not revive', () => {
    const a = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const t = row({ key: 'home_city', value: null, createdAt: '2026-01-02T00:00:00Z' });
    expect(recallPreferences(U, [a, t], []).home_city).toBeUndefined();
  });

  it('a save after a tombstone makes the key exist again', () => {
    const a = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const t = row({ key: 'home_city', value: null, createdAt: '2026-01-02T00:00:00Z' });
    const c = row({ key: 'home_city', value: 'Dubai', createdAt: '2026-01-03T00:00:00Z' });
    expect(recallPreferences(U, [a, t, c], []).home_city?.value).toBe('Dubai');
  });

  it('deleting an OLDER row does not affect the latest row', () => {
    const a = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const b = row({ key: 'home_city', value: 'Tokyo', createdAt: '2026-01-02T00:00:00Z' });
    expect(recallPreferences(U, [a, b], [{ memoryId: a.id, userId: U }]).home_city?.value).toBe('Tokyo');
  });

  it('ties on created_at are broken by id DESC', () => {
    const t = '2026-01-01T00:00:00Z';
    const a = { ...row({ key: 'home_city', value: 'Shanghai', createdAt: t }), id: 'm_A' };
    const b = { ...row({ key: 'home_city', value: 'Tokyo', createdAt: t }), id: 'm_B' };
    expect(recallPreferences(U, [a, b], []).home_city?.value).toBe('Tokyo');
    expect(recallPreferences(U, [b, a], []).home_city?.value).toBe('Tokyo');
    // equal instants written in different ISO spellings are still a tie
    const c = { ...b, createdAt: '2026-01-01T08:00:00+08:00', id: 'm_0' };
    expect(recallPreferences(U, [a, c], []).home_city?.value).toBe('Shanghai'); // m_A > m_0
  });

  it('keys are independent', () => {
    const a = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const b = row({ key: 'preferred_language', value: 'zh', createdAt: '2026-01-02T00:00:00Z' });
    const del = [{ memoryId: b.id, userId: U }];
    const r = recallPreferences(U, [a, b], del);
    expect(r.home_city?.value).toBe('Shanghai');
    expect(r.preferred_language).toBeUndefined();
  });

  it('ignores other users rows and deletions', () => {
    const mine = row({ key: 'home_city', value: 'Shanghai', createdAt: '2026-01-01T00:00:00Z' });
    const theirs = row({ key: 'home_city', value: 'Tokyo', createdAt: '2026-01-05T00:00:00Z', userId: 'u2' });
    expect(recallPreferences(U, [mine, theirs], []).home_city?.value).toBe('Shanghai');
    expect(recallPreferences(U, [mine], [{ memoryId: mine.id, userId: 'u2' }]).home_city?.value).toBe('Shanghai');
  });

  it('empty input => empty result; invalid createdAt throws', () => {
    expect(recallPreferences(U, [], [])).toEqual({});
    const a = row({ key: 'home_city', value: 'x', createdAt: 'nope' });
    const b = row({ key: 'home_city', value: 'y', createdAt: '2026-01-01T00:00:00Z' });
    expect(() => recallPreferences(U, [a, b], [])).toThrow(RangeError);
  });

  it('property: result is independent of input order', () => {
    const rowArb = fc.record({
      id: fc.integer({ min: 0, max: 30 }).map((i) => `m_${String(i).padStart(3, '0')}`),
      key: fc.constantFrom('home_city' as const, 'preferred_language' as const),
      value: fc.option(fc.constantFrom('Shanghai', 'Tokyo', 'zh', 'en'), { nil: null }),
      t: fc.integer({ min: 0, max: 5 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 6 }),
        fc.infiniteStream(fc.nat()),
        (rs, delIdx, rnd) => {
          const rows: MemoryRow[] = rs.map((r) => ({
            id: r.id,
            userId: U,
            key: r.key,
            value: r.value,
            sourceSessionId: 's',
            sourceSeq: 1,
            createdAt: new Date(Date.UTC(2026, 0, 1 + r.t)).toISOString(),
          }));
          const dels = delIdx.map((i) => ({ memoryId: `m_${String(i).padStart(3, '0')}`, userId: U }));
          const shuffled = [...rows].sort(() => (rnd.next().value % 3) - 1);
          const shuffledDels = [...dels].reverse();
          expect(recallPreferences(U, shuffled, shuffledDels)).toEqual(recallPreferences(U, rows, dels));
        },
      ),
    );
  });
});
