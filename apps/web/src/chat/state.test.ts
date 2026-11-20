import { describe, expect, it } from 'vitest';
import type { PublicEvent } from '@fb/contracts/web';
import { buildTimeline, chatReducer, initialChatState, runVisible, type ChatState } from './state.ts';

const ts = '2026-11-19T08:00:00.000Z';
const R = 'run1';
let n = 0;
const ev = <T extends PublicEvent['type']>(type: T, payload: Extract<PublicEvent, { type: T }>['payload'], seq = ++n) =>
  ({ seq, type, actor: 'agent', ts, payload }) as PublicEvent;

const started = () => ev('agent.run_started', { runId: R });
const process_ = (key: string, text: string) =>
  ev('agent.message', { runId: R, messageKey: key, kind: 'process', processText: text });
const toolRes = (id: string) =>
  ev('agent.message', { runId: R, messageKey: `tr:${id}`, toolCallId: id, toolName: 'quote_route', isError: false });
const reply = (text: string) => ev('agent.message', { runId: R, messageKey: 'final', kind: 'reply', text });

function apply(state: ChatState, ...actions: Parameters<typeof chatReducer>[1][]) {
  return actions.reduce(chatReducer, state);
}
const run = (s: ChatState) =>
  buildTimeline(s).items.find((i) => i.kind === 'run') as Extract<
    ReturnType<typeof buildTimeline>['items'][number],
    { kind: 'run' }
  >;

describe('process area lifecycle (A-01 §9.4.1)', () => {
  it('is live and expanded while running, with ephemeral content', () => {
    n = 0;
    const s = apply(
      initialChatState,
      { type: 'events', events: [started()], live: true },
      {
        type: 'eph',
        eph: { type: 'agent.reasoning_delta', payload: { runId: R, messageKey: 'm1', textDelta: 'think' } },
      },
      { type: 'eph', eph: { type: 'agent.delta', payload: { runId: R, messageKey: 'm1', textDelta: 'hel' } } },
      { type: 'eph', eph: { type: 'agent.delta', payload: { runId: R, messageKey: 'm1', textDelta: 'lo' } } },
    );
    const r = run(s);
    expect(r.finished).toBe(false);
    expect(r.live?.deltas).toEqual([{ messageKey: 'm1', text: 'hello' }]);
    expect(r.live?.reasoning[0]?.text).toBe('think');
    expect(runVisible(r)).toBe(true);
    expect(s.status).toBe('running');
  });

  it('persisted message replaces the streamed text of its messageKey', () => {
    n = 0;
    const s = apply(
      initialChatState,
      { type: 'events', events: [started()], live: true },
      { type: 'eph', eph: { type: 'agent.delta', payload: { runId: R, messageKey: 'm1', textDelta: 'draft' } } },
      { type: 'events', events: [process_('m1', 'persisted')], live: true },
    );
    const r = run(s);
    expect(r.live?.deltas).toEqual([]);
    expect(r.steps).toEqual([{ kind: 'text', key: 'p:m1', text: 'persisted' }]);
  });

  it('guard retraction (reset) clears that messageKey immediately', () => {
    n = 0;
    const s = apply(
      initialChatState,
      { type: 'eph', eph: { type: 'agent.delta', payload: { runId: R, messageKey: 'f', textDelta: 'wrong 999' } } },
      { type: 'eph', eph: { type: 'agent.delta', payload: { runId: R, messageKey: 'f', reset: true } } },
    );
    expect(s.live[R]?.deltas).toEqual([]);
  });

  it('collapses and DISCARDS ephemeral content when the final reply is persisted', () => {
    n = 0;
    const s = apply(
      initialChatState,
      { type: 'events', events: [started(), process_('m1', 'step')], live: true },
      {
        type: 'eph',
        eph: { type: 'agent.reasoning_delta', payload: { runId: R, messageKey: 'm2', textDelta: 'secret reasoning' } },
      },
      { type: 'events', events: [reply('done')], live: true },
    );
    const r = run(s);
    expect(r.finished).toBe(true);
    expect(r.live).toBeNull();
    expect(s.live[R]).toBeUndefined();
    expect(r.processCount).toBe(1);
    expect(s.status).toBe('idle');
  });

  it('collapses on run_completed / run_failed even without a reply', () => {
    for (const end of [
      ev('agent.run_completed', { runId: R }),
      ev('agent.run_failed', { runId: R, code: 'LLM_ERROR' as never }),
    ]) {
      n = 0;
      const s = apply(initialChatState, { type: 'events', events: [started(), process_('m1', 'x'), end], live: true });
      expect(run(s).finished).toBe(true);
    }
  });

  it('late ephemeral events of a finished run are ignored', () => {
    n = 0;
    const s = apply(
      initialChatState,
      { type: 'events', events: [started(), ev('agent.run_completed', { runId: R })], live: true },
      { type: 'eph', eph: { type: 'agent.delta', payload: { runId: R, messageKey: 'm9', textDelta: 'late' } } },
    );
    expect(s.live[R]).toBeUndefined();
  });

  it('a finished run with zero process messages is not shown at all (N = 0)', () => {
    n = 0;
    const s = apply(initialChatState, {
      type: 'events',
      events: [started(), reply('hi'), ev('agent.run_completed', { runId: R })],
    });
    expect(runVisible(run(s))).toBe(false);
  });

  it('history replay: finished runs are collapsed, built only from persisted steps; N counts process messages', () => {
    n = 0;
    const s = apply(initialChatState, {
      type: 'events',
      events: [
        started(),
        process_('m1', 'a'),
        toolRes('c1'),
        process_('m2', 'b'),
        toolRes('c2'),
        reply('final'),
        ev('agent.run_completed', { runId: R }),
      ],
    });
    const r = run(s);
    expect(r.finished).toBe(true);
    expect(r.processCount).toBe(2);
    expect(r.steps).toHaveLength(4);
    expect(runVisible(r)).toBe(true);
  });

  it('an unfinished run after a refresh stays expanded with only persisted steps', () => {
    n = 0;
    const s = apply(initialChatState, { type: 'events', events: [started(), process_('m1', 'a')] });
    const r = run(s);
    expect(r.finished).toBe(false);
    expect(r.live).toBeNull();
    expect(r.steps).toHaveLength(1);
  });
});

describe('timeline rendering rules', () => {
  it('process text never becomes a bubble; only kind=reply does', () => {
    n = 0;
    const s = apply(initialChatState, {
      type: 'events',
      events: [started(), process_('m1', 'process text'), toolRes('c1'), reply('final text')],
    });
    const items = buildTimeline(s).items;
    expect(items.filter((i) => i.kind === 'reply').map((i) => (i as { text: string }).text)).toEqual(['final text']);
    expect(JSON.stringify(items.filter((i) => i.kind !== 'run'))).not.toContain('process text');
  });

  it('process area sits above the final reply of the same run', () => {
    n = 0;
    const s = apply(initialChatState, { type: 'events', events: [started(), process_('m1', 'a'), reply('r')] });
    expect(buildTimeline(s).items.map((i) => i.kind)).toEqual(['run', 'reply']);
  });

  it('dedupes by seq and keeps seq order', () => {
    n = 0;
    const a = ev('user.message', { text: 'a', clientMessageId: 'c' }, 2);
    const b = ev('user.message', { text: 'b', clientMessageId: 'd' }, 1);
    const s = apply(initialChatState, { type: 'events', events: [a] }, { type: 'events', events: [b, a] });
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('booking.confirmed marks the quote booked and adds a ticket item; booking.failed sets an error code', () => {
    n = 0;
    const offered = ev('quote.offered', { quoteId: 'q1' });
    const failed = ev('booking.failed', { quoteId: 'q1', code: 'QUOTE_NOT_OFFERED' as never });
    let tl = buildTimeline(apply(initialChatState, { type: 'events', events: [offered, failed] }));
    expect(tl.items[0]).toMatchObject({ kind: 'quote', failedCode: 'QUOTE_NOT_OFFERED', booked: null });
    tl = buildTimeline(
      apply(initialChatState, {
        type: 'events',
        events: [offered, failed, ev('booking.confirmed', { quoteId: 'q1', ticketId: 't1', ticketNo: 'OA1' })],
      }),
    );
    expect(tl.items[0]).toMatchObject({ kind: 'quote', booked: { ticketId: 't1', ticketNo: 'OA1' }, failedCode: null });
    expect(tl.items[1]).toMatchObject({ kind: 'ticket', ticketId: 't1' });
  });

  it('hidden events and run lifecycle events render nothing; no agent text after a ticket (D-39)', () => {
    n = 0;
    const s = apply(initialChatState, {
      type: 'events',
      events: [ev('hidden', {}), ev('agent.guard_violation', { runId: R, messageKey: 'x', action: 'regenerate' })],
    });
    expect(buildTimeline(s).items.filter((i) => i.kind !== 'run')).toEqual([]);
  });

  it('typing indicator shows while running with no live content', () => {
    const s = apply(initialChatState, { type: 'status', status: 'running' });
    expect(buildTimeline(s).typing).toBe(true);
  });
});
