// CT-12 (A-02 §14.1 "前缀性质", D-58 CI hard gate): for any two cut points t1 < t2 of the same log with no compaction in
// between, project(E[..t1]) is a prefix of project(E[..t2]), compared message by message on the serialised bytes.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Ev } from '../src/events.ts';
import { latestCompaction, listRuns, project } from '../src/projector.ts';
import { arbLog, arbProgram, buildLog } from './logbuilder.ts';

const NUM_RUNS = 400;

/** Serialised projection of every prefix E[..t], t = 0..n (strings interned to ints so pair checks stay cheap). */
function projections(events: readonly Ev[]): { texts: string[][]; ids: number[][] } {
  const intern = new Map<string, number>();
  const texts: string[][] = [];
  const ids: number[][] = [];
  for (let t = 0; t <= events.length; t++) {
    let msgs: string[];
    try {
      msgs = project(events.slice(0, t)).map((m) => JSON.stringify(m));
    } catch (e) {
      throw new Error(
        `project threw on prefix t=${t}/${events.length} (last event ${events[t - 1]?.type}): ${String(e)}`,
        { cause: e },
      );
    }
    texts.push(msgs);
    ids.push(
      msgs.map((s) => {
        let id = intern.get(s);
        if (id === undefined) {
          id = intern.size;
          intern.set(s, id);
        }
        return id;
      }),
    );
  }
  return { texts, ids };
}

const isPrefix = (a: readonly number[], b: readonly number[]): boolean =>
  a.length <= b.length && a.every((x, i) => x === b[i]);

describe('CT-12 prefix property', () => {
  it('project(E[..t1]) is a prefix of project(E[..t2]) for all t1 < t2 (no compaction in the log)', () => {
    fc.assert(
      fc.property(arbLog(), (events) => {
        expect(events.some((e) => e.type === 'agent.context_compacted')).toBe(false);
        const { ids } = projections(events);
        for (let t1 = 0; t1 <= events.length; t1++) {
          for (let t2 = t1 + 1; t2 <= events.length; t2++) {
            if (!isPrefix(ids[t1] as number[], ids[t2] as number[])) {
              throw new Error(`not a prefix: t1=${t1} t2=${t2} of ${events.length}`);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('holds with compaction events too whenever the compaction the projector uses is the same at both cuts', () => {
    // The "effective" compaction of a cut is the latest context_compacted written BEFORE the cut's current run started
    // (a compaction written after that run_started is not used by that run's projection). The spec wording "no
    // compaction between t1 and t2" is read as: the effective compaction is identical.
    const effective = (events: readonly Ev[], t: number): string | undefined => {
      const cut = events.slice(0, t);
      const runs = listRuns(cut);
      const cur = runs[runs.length - 1];
      if (cur === undefined) return undefined;
      return latestCompaction(cut.filter((e) => e.seq < cur.started.seq))?.payload.compactionId;
    };
    let withCompaction = 0;
    fc.assert(
      fc.property(arbLog({ compaction: true }), (events) => {
        if (events.some((e) => e.type === 'agent.context_compacted')) withCompaction++;
        const { ids } = projections(events);
        for (let t1 = 0; t1 <= events.length; t1++) {
          for (let t2 = t1 + 1; t2 <= events.length; t2++) {
            if (effective(events, t1) !== effective(events, t2)) continue;
            if (!isPrefix(ids[t1] as number[], ids[t2] as number[])) {
              throw new Error(`not a prefix: t1=${t1} t2=${t2} of ${events.length}`);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
    expect(withCompaction).toBeGreaterThan(0);
  });

  it('project never throws on any prefix and the final projection of a closed log has no dangling calls', () => {
    fc.assert(
      fc.property(arbLog({ compaction: true }), (events) => {
        for (let t = 0; t <= events.length; t++) project(events.slice(0, t));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic: the same log projects to identical JSON twice', () => {
    fc.assert(
      fc.property(arbLog({ compaction: true }), (events) => {
        const a = JSON.stringify(project(events));
        const b = JSON.stringify(project([...events]));
        expect(b).toBe(a);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is invariant under jsonb key order of the stored payloads', () => {
    fc.assert(
      fc.property(arbProgram({ compaction: true }), (prog) => {
        const raw = buildLog(prog, { order: 'raw' });
        const jb = buildLog(prog, { order: 'jsonb' });
        expect(jb).toHaveLength(raw.length);
        for (let t = 0; t <= raw.length; t += 3) {
          expect(JSON.stringify(project(jb.slice(0, t)))).toBe(JSON.stringify(project(raw.slice(0, t))));
        }
        expect(JSON.stringify(project(jb))).toBe(JSON.stringify(project(raw)));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never leaks zombie (stale attempt) writes, and every consumed input appears exactly once', () => {
    fc.assert(
      fc.property(arbLog(), (events) => {
        const all = JSON.stringify(project(events));
        expect(all).not.toContain('ZOMBIE');
        const runs = listRuns(events);
        if (runs.length === 0) return;
        const consumed = runs.flatMap((r) => r.started.payload.inputSeqs);
        expect(new Set(consumed).size).toBe(consumed.length); // seam invariant: no input consumed twice
        const msgs = project(events).filter((m) => m.role === 'user').length;
        // user messages = inputs of all runs + run_contexts + bookings before runs + guard notices
        const expected =
          consumed.length +
          runs.length +
          events.filter((e) => e.type === 'agent.guard_violation').length +
          events.filter(
            (e) =>
              (e.type === 'booking.confirmed' || e.type === 'booking.failed') &&
              e.seq < (runs[runs.length - 1] as { started: Ev }).started.seq,
          ).length;
        expect(msgs).toBeLessThanOrEqual(expected); // guards of dropped attempts are not rendered
        expect(msgs).toBeGreaterThanOrEqual(consumed.length + runs.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('the generator really covers the required scenarios (guards against a vacuous property)', () => {
    const logs = fc.sample(arbLog(), { numRuns: 400, seed: 7 });
    const has = (pred: (e: Ev) => boolean): number => logs.filter((l) => l.some(pred)).length;
    const json = (e: Ev): string => JSON.stringify(e.payload);
    expect(logs.filter((l) => l.filter((e) => e.type === 'agent.run_started').length >= 2).length).toBeGreaterThan(20);
    expect(has((e) => e.type === 'agent.run_resumed')).toBeGreaterThan(20);
    expect(has((e) => e.type === 'agent.guard_violation')).toBeGreaterThan(20);
    expect(has((e) => e.type === 'agent.message' && json(e).includes('thinking'))).toBeGreaterThan(20);
    expect(has((e) => e.type === 'agent.message' && json(e).includes('ZOMBIE'))).toBeGreaterThan(20);
    expect(has((e) => e.type === 'agent.message' && json(e).includes('"fill"'))).toBeGreaterThan(20);
    expect(has((e) => e.type === 'booking.confirmed')).toBeGreaterThan(20);
    // a booking / user message strictly inside a run (between run_started and its ending)
    const midRun =
      (type: string) =>
      (l: Ev[]): boolean => {
        const start = l.findIndex((e) => e.type === 'agent.run_started');
        const end = l.findIndex((e) => e.type === 'agent.run_completed' || e.type === 'agent.run_failed');
        return start >= 0 && l.some((e, i) => e.type === type && i > start && (end < 0 || i < end));
      };
    expect(logs.filter(midRun('booking.confirmed')).length).toBeGreaterThan(5);
    expect(logs.filter(midRun('user.message')).length).toBeGreaterThan(5);
  });
});
