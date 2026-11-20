// compactor (A-02 §4.5, §14.1 "compactor" row).
import { COMPACT_HIGH, COMPACT_LOW, COMPACT_MAX_QUOTES } from '@fb/contracts/flight';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../src/events.ts';
import { compact, estimateTokens, FIXED_TOKENS, messageText, summarize } from '../src/compactor.ts';
import { projectDetailed } from '../src/projector.ts';
import { LogBuilder, quoteIdN } from './logbuilder.ts';

const HEAVY = 'x'.repeat(3000); // 1000 tokens

interface QuoteSpec {
  readonly id: string;
  readonly via?: readonly string[];
  readonly from?: string;
  readonly to?: string;
}
function quoteData(q: QuoteSpec): Record<string, unknown> {
  const from = q.from ?? 'Shanghai';
  const to = q.to ?? 'Tokyo';
  const stops = [from, ...(q.via ?? []), to];
  return {
    quoteId: q.id,
    from,
    to,
    legs: stops.slice(1).map((s, i) => ({ from: stops[i], to: s, distanceKm: 3259.93 })),
    transferCities: [...(q.via ?? [])],
    totalDistanceKm: 3259.93,
    priceCents: 42379,
    display: { legs: [], totalDistanceKm: '3259.93', priceUsd: '423.79' },
    dataSha256: 'a'.repeat(64),
    createdAt: '2026-11-19T08:00:00.000Z',
  };
}

/** one finished run: user input, optional quote_route call, heavy (1000 token) final reply. */
function finishedRun(
  b: LogBuilder,
  label: string,
  o: { quote?: QuoteSpec; heavy?: boolean; errorQuote?: boolean } = {},
): string {
  b.userMessage(`q ${label}`);
  const r = b.startRun();
  if (o.quote !== undefined) {
    b.assistantToolCalls(r, { calls: [{ name: 'quote_route' }], ids: [`c_${label}`] });
    b.toolResult(r, `c_${label}`, {
      text: 'Quote ok',
      data: quoteData(o.quote),
      ...(o.errorQuote === true ? { isError: true } : {}),
    });
  }
  b.assistantFinal(r, { text: o.heavy === false ? 'ok' : HEAVY });
  b.complete(r);
  return r;
}

const sizeOfRun = (events: readonly Ev[], runId: string): number => {
  const p = projectDetailed(events, runId);
  let t = 0;
  p.messages.forEach((m, i) => {
    if (p.runOf[i] === runId) t += estimateTokens(messageText(m));
  });
  return t;
};

describe('estimateTokens (§4.5 step 1)', () => {
  it('CJK chars count 1 each, other chars 1 per 3 (rounded up)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('上海')).toBe(2);
    expect(estimateTokens('上海abc')).toBe(3);
    expect(estimateTokens('ひらがな')).toBe(4);
  });
});

describe('compact() thresholds', () => {
  it('no run yet or no pending input -> null', () => {
    const b = new LogBuilder();
    const u = b.userMessage(HEAVY.repeat(50));
    expect(compact(b.events, [u], { high: 1, low: 1 })).toBeNull();
    finishedRun(b, 'a');
    expect(compact(b.events, [], { high: 1, low: 1 })).toBeNull();
  });

  it('default thresholds: a small session is never compacted; H and L come from the contract', () => {
    const b = new LogBuilder();
    for (let i = 0; i < 5; i++) finishedRun(b, `r${i}`);
    const u = b.userMessage('next');
    expect(compact(b.events, [u])).toBeNull();
    expect(COMPACT_HIGH).toBe(40_000);
    expect(COMPACT_LOW).toBe(16_000);
  });

  it('est <= H -> null (inclusive), est > H -> compacts', () => {
    const b = new LogBuilder();
    for (let i = 0; i < 4; i++) finishedRun(b, `r${i}`);
    const u = b.userMessage('next');
    const probe = compact(b.events, [u], { high: 0, low: FIXED_TOKENS });
    expect(probe).not.toBeNull();
    const est = (probe as NonNullable<typeof probe>).estBefore;
    expect(compact(b.events, [u], { high: est, low: FIXED_TOKENS })).toBeNull();
    expect(compact(b.events, [u], { high: est - 1, low: FIXED_TOKENS })).not.toBeNull();
  });
});

describe('compact() boundary choice', () => {
  function fiveRuns(): { b: LogBuilder; runs: string[]; pending: number } {
    const b = new LogBuilder();
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) runs.push(finishedRun(b, `r${i}`));
    const pending = b.userMessage('next');
    return { b, runs, pending };
  }

  it('keeps as many whole finished runs as fit in L (with the new run); boundary = earliest kept', () => {
    const { b, runs, pending } = fiveRuns();
    const s = sizeOfRun(b.events, runs[4] as string);
    const low = FIXED_TOKENS + 100 + estimateTokens('next') + 2 * s + Math.floor(s / 2);
    const c = compact(b.events, [pending], { high: low + 100, low });
    expect(c).not.toBeNull();
    expect(c?.boundaryRunId).toBe(runs[3]);
    expect(c?.compactionId).toBe(`cmp_${runs[3] as string}`);
    expect(c?.summaryVersion).toBe(1);
    expect(c?.estBefore).toBeGreaterThan(low + 100);
    // kept size (without the summary text) fits in L
    expect((c?.estAfter ?? 0) - estimateTokens(c?.summaryText ?? '')).toBeLessThanOrEqual(low);
    expect(c?.estAfter).toBeLessThan(c?.estBefore ?? 0);
  });

  it('keeps one more run each time L grows by one run', () => {
    const { b, runs, pending } = fiveRuns();
    const s = sizeOfRun(b.events, runs[4] as string);
    const base = FIXED_TOKENS + 100 + estimateTokens('next');
    const keep = (n: number): string | undefined =>
      compact(b.events, [pending], { high: base + 10, low: base + n * s + Math.floor(s / 2) })?.boundaryRunId;
    expect(keep(1)).toBe(runs[4]);
    expect(keep(2)).toBe(runs[3]);
    expect(keep(3)).toBe(runs[2]);
    expect(keep(4)).toBe(runs[1]);
  });

  it('always keeps at least the latest finished run, even if it alone exceeds L', () => {
    const { b, runs, pending } = fiveRuns();
    const c = compact(b.events, [pending], { high: FIXED_TOKENS + 10, low: FIXED_TOKENS });
    expect(c?.boundaryRunId).toBe(runs[4]);
  });

  it('when every run fits in L the boundary is the first run: nothing to fold -> null', () => {
    const { b, pending } = fiveRuns();
    const est = compact(b.events, [pending], { high: 0, low: FIXED_TOKENS })?.estBefore ?? 0;
    expect(compact(b.events, [pending], { high: est - 1, low: 10_000_000 })).toBeNull();
  });

  it('no recompaction when the boundary equals the latest compaction boundary', () => {
    const { b, runs, pending } = fiveRuns();
    const opts = { high: FIXED_TOKENS + 10, low: FIXED_TOKENS };
    const first = compact(b.events, [pending], opts);
    expect(first?.boundaryRunId).toBe(runs[4]);
    b.compact(runs[4] as string, first?.summaryText);
    expect(compact(b.events, [pending], opts)).toBeNull();
  });

  it('a later compaction moves the boundary forward once more runs exist', () => {
    const { b, runs } = fiveRuns();
    b.compact(runs[2] as string);
    const r5 = b.startRun();
    b.assistantFinal(r5, { text: HEAVY });
    b.complete(r5);
    const next = b.userMessage('next2');
    const c = compact(b.events, [next], { high: FIXED_TOKENS + 10, low: FIXED_TOKENS });
    expect(c?.boundaryRunId).toBe(r5);
    expect(c?.compactionId).toBe(`cmp_${r5}`);
  });

  it('a session with a single finished run cannot be compacted', () => {
    const b = new LogBuilder();
    finishedRun(b, 'only');
    const u = b.userMessage('next');
    expect(compact(b.events, [u], { high: 1, low: 1 })).toBeNull();
  });

  it('is pure: the input log is not mutated', () => {
    const { b, pending } = fiveRuns();
    const before = JSON.stringify(b.events);
    compact(b.events, [pending], { high: FIXED_TOKENS + 10, low: FIXED_TOKENS });
    expect(JSON.stringify(b.events)).toBe(before);
  });
});

describe('summaryText (§4.5 step 5)', () => {
  it('is deterministic: two calls give byte-identical payloads', () => {
    const b = new LogBuilder();
    for (let i = 0; i < 4; i++) {
      finishedRun(b, `r${i}`, { quote: { id: quoteIdN(i + 1), via: i % 2 === 0 ? ['Dubai'] : [] } });
    }
    const u = b.userMessage('next');
    const opts = { high: FIXED_TOKENS + 10, low: FIXED_TOKENS };
    const a = compact(b.events, [u], opts);
    const c = compact(b.events, [u], opts);
    expect(a).not.toBeNull();
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(a?.summaryText).toBe(c?.summaryText);
  });

  it('exact shape: covered_runs, quote lines (direct / transfers), tickets, sorted cities, note', () => {
    const b = new LogBuilder();
    const booking = b.bookingConfirmed({ from: 'Osaka', to: 'Tokyo' }); // before run 1 -> folded, listed
    finishedRun(b, 'a', { quote: { id: quoteIdN(1), from: 'Shanghai', to: 'São Paulo', via: ['Dubai'] } });
    finishedRun(b, 'b', { quote: { id: quoteIdN(2), from: 'Shanghai', to: 'Tokyo' } });
    finishedRun(b, 'c', { quote: { id: quoteIdN(3), from: 'Zurich', to: 'Oslo', via: ['Paris', 'Rome'] } });
    const keep = finishedRun(b, 'keep');
    const ticketNo = (booking.payload as { ticketNo: string }).ticketNo;
    expect(summarize(b.events, keep)).toBe(
      [
        '<system_event type="context_compacted">',
        'covered_runs: 3',
        `quote: ${quoteIdN(1)} Shanghai -> Dubai -> São Paulo (1 transfer at Dubai)`,
        `quote: ${quoteIdN(2)} Shanghai -> Tokyo (direct)`,
        `quote: ${quoteIdN(3)} Zurich -> Paris -> Rome -> Oslo (2 transfers at Paris, Rome)`,
        `ticket: ${ticketNo} Osaka -> Tokyo`,
        'cities: Dubai, Osaka, Oslo, Paris, Rome, Shanghai, São Paulo, Tokyo, Zurich',
        'note: earlier conversation was offloaded. Use list_my_tickets for tickets; quotes can still be offered by quoteId.',
        '</system_event>',
      ].join('\n'),
    );
  });

  it('contains no distance / price numbers (quote_route data carries 3259.93 / 423.79)', () => {
    const b = new LogBuilder();
    for (let i = 0; i < 3; i++) {
      b.bookingConfirmed({ distanceKm: '3259.93', priceUsd: '423.79' });
      finishedRun(b, `r${i}`, { quote: { id: quoteIdN(i + 1), via: ['Dubai'] } });
    }
    const u = b.userMessage('next');
    const c = compact(b.events, [u], { high: FIXED_TOKENS + 10, low: FIXED_TOKENS });
    expect(c).not.toBeNull();
    const s = c?.summaryText ?? '';
    for (const bad of ['3259', '423.79', '42379', 'priceUsd', 'distance']) expect(s).not.toContain(bad);
    expect(s).not.toMatch(/\d+\.\d+/);
    expect(s).toContain('quote: ');
    expect(s).toContain('ticket: ');
  });

  it(`lists at most ${COMPACT_MAX_QUOTES} quotes: the most recent ones, oldest first`, () => {
    const b = new LogBuilder();
    for (let i = 1; i <= 25; i++) finishedRun(b, `r${i}`, { quote: { id: quoteIdN(i) }, heavy: false });
    const keep = finishedRun(b, 'keep', { heavy: false });
    const s = summarize(b.events, keep);
    const lines = s.split('\n').filter((l) => l.startsWith('quote: '));
    expect(lines).toHaveLength(COMPACT_MAX_QUOTES);
    expect(lines[0]).toContain(quoteIdN(6));
    expect(lines.at(-1)).toContain(quoteIdN(25));
    expect(s).toContain('covered_runs: 25');
  });

  it('at most 20 ticket lines (most recent) and at most 30 cities', () => {
    const b = new LogBuilder();
    for (let i = 1; i <= 25; i++) {
      b.bookingConfirmed({ from: `From${String(i).padStart(2, '0')}`, to: `To${String(i).padStart(2, '0')}` });
    }
    finishedRun(b, 'a', { heavy: false });
    const keep = finishedRun(b, 'keep', { heavy: false });
    const s = summarize(b.events, keep);
    const tickets = s.split('\n').filter((l) => l.startsWith('ticket: '));
    expect(tickets).toHaveLength(20);
    expect(tickets[0]).toContain('From06 -> To06');
    const cities = (s.split('\n').find((l) => l.startsWith('cities: ')) ?? '').slice('cities: '.length).split(', ');
    expect(cities).toHaveLength(30);
    expect([...cities]).toEqual([...cities].sort());
  });

  it('only successful quote_route results of FOLDED runs; bookings hung before the boundary run stay out', () => {
    const b = new LogBuilder();
    b.bookingConfirmed({ from: 'AAA', to: 'BBB' }); // before run 1: folded
    finishedRun(b, 'r1', { quote: { id: quoteIdN(1) }, heavy: false });
    finishedRun(b, 'err', { quote: { id: quoteIdN(2) }, errorQuote: true, heavy: false });
    b.bookingConfirmed({ from: 'CCC', to: 'DDD' }); // hangs before the boundary run: not summarised
    const keep = finishedRun(b, 'keep', { quote: { id: quoteIdN(3), from: 'Keep', to: 'Run' }, heavy: false });
    const s = summarize(b.events, keep);
    expect(s).toContain(quoteIdN(1));
    expect(s).not.toContain(quoteIdN(2)); // isError result ignored
    expect(s).not.toContain(quoteIdN(3)); // the boundary run itself is not folded
    expect(s).toContain('AAA -> BBB');
    expect(s).not.toContain('CCC');
    expect(s).toContain('covered_runs: 2');
    expect(s).not.toContain('Keep');
  });

  it('does not depend on earlier compaction summaries (rebuilt from the full log)', () => {
    const mk = (withOld: boolean): { events: Ev[]; pending: number } => {
      const b = new LogBuilder();
      const runs: string[] = [];
      for (let i = 0; i < 5; i++) runs.push(finishedRun(b, `r${i}`, { quote: { id: quoteIdN(i + 1) } }));
      if (withOld) b.compact(runs[1] as string, 'OLD-SUMMARY-MUST-NOT-LEAK');
      const pending = b.userMessage('next');
      return { events: b.events, pending };
    };
    const opts = { high: FIXED_TOKENS + 10, low: FIXED_TOKENS };
    const plain = mk(false);
    const old = mk(true);
    const a = compact(plain.events, [plain.pending], opts);
    const c = compact(old.events, [old.pending], opts);
    expect(a).not.toBeNull();
    expect(c?.boundaryRunId).toBe(a?.boundaryRunId);
    expect(c?.summaryText).toBe(a?.summaryText);
    expect(c?.summaryText).not.toContain('OLD-SUMMARY');
  });

  it('after writing the compaction the projection starts with the summary and is smaller than before', () => {
    const b = new LogBuilder();
    for (let i = 0; i < 5; i++) finishedRun(b, `r${i}`, { quote: { id: quoteIdN(i + 1) } });
    const u = b.userMessage('next');
    const c = compact(b.events, [u], { high: FIXED_TOKENS + 10, low: FIXED_TOKENS });
    if (c === null) throw new Error('expected a compaction');
    b.compact(c.boundaryRunId, c.summaryText);
    b.startRun();
    const msgs = projectDetailed(b.events).messages;
    expect(messageText(msgs[0] as (typeof msgs)[number])).toBe(c.summaryText);
    const est = FIXED_TOKENS + msgs.reduce((n, m) => n + estimateTokens(messageText(m)), 0);
    expect(est).toBeLessThan(c.estBefore);
    expect(est).toBeLessThanOrEqual(c.estAfter); // the estimate budgets 100 tokens for the real run_context
  });
});
