// computeWork (A-02 §3.3) table tests.
import { describe, expect, it } from 'vitest';
import { computeWork, findOpenRun } from '../src/work.ts';
import { LogBuilder } from './logbuilder.ts';

describe('computeWork (§3.3)', () => {
  it('empty log -> none', () => {
    expect(computeWork([])).toEqual({ kind: 'none' });
  });

  it('only booking events (never an input) -> none', () => {
    const b = new LogBuilder();
    b.bookingConfirmed();
    b.bookingFailed();
    expect(computeWork(b.events)).toEqual({ kind: 'none' });
  });

  it('pending user messages, no run -> start with ALL of them ascending', () => {
    const b = new LogBuilder();
    const a = b.userMessage('a');
    b.bookingConfirmed();
    const c = b.userMessage('b');
    const d = b.userMessage('c');
    expect(computeWork(b.events)).toEqual({ kind: 'start', inputSeqs: [a, c, d] });
  });

  it('open run -> resume it; inputs arriving during the run are NOT merged', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r = b.startRun();
    b.userMessage('during');
    b.bookingConfirmed();
    expect(computeWork(b.events)).toEqual({ kind: 'resume', runId: r });
    expect(findOpenRun(b.events)).toBe(r);
  });

  it('open run after run_resumed is still the same run to resume', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r = b.startRun();
    b.resume(r);
    b.resume(r);
    expect(computeWork(b.events)).toEqual({ kind: 'resume', runId: r });
  });

  it('run_completed closes the run: nothing pending -> none; a later input -> start with it only', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r = b.startRun();
    b.complete(r);
    expect(computeWork(b.events)).toEqual({ kind: 'none' });
    const later = b.userMessage('later');
    expect(computeWork(b.events)).toEqual({ kind: 'start', inputSeqs: [later] });
  });

  it('run_failed closes a run as well; the input that arrived during it is then pending', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r = b.startRun();
    const during = b.userMessage('during');
    b.fail(r, 'RUN_TIMEOUT', true);
    expect(findOpenRun(b.events)).toBeUndefined();
    expect(computeWork(b.events)).toEqual({ kind: 'start', inputSeqs: [during] });
  });

  it('an input that arrived mid-run is consumed by the next run together with later ones, then none', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r1 = b.startRun();
    const mid = b.userMessage('mid');
    b.complete(r1);
    const late = b.userMessage('late');
    expect(computeWork(b.events)).toEqual({ kind: 'start', inputSeqs: [mid, late] });
    const r2 = b.startRun();
    expect(computeWork(b.events)).toEqual({ kind: 'resume', runId: r2 });
    b.complete(r2);
    expect(computeWork(b.events)).toEqual({ kind: 'none' });
  });

  it('the open run is the LAST run_started (an earlier completed run does not matter)', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r1 = b.startRun();
    b.complete(r1);
    b.userMessage('b');
    const r2 = b.startRun();
    expect(computeWork(b.events)).toEqual({ kind: 'resume', runId: r2 });
  });

  it('guard / message / compaction events do not create work', () => {
    const b = new LogBuilder();
    b.userMessage('a');
    const r = b.startRun();
    b.guardRegenerate(r);
    b.assistantFinal(r, { text: 'x' });
    b.complete(r);
    b.compact(r);
    expect(computeWork(b.events)).toEqual({ kind: 'none' });
  });

  it('start inputs are ascending', () => {
    const b = new LogBuilder();
    for (let i = 0; i < 5; i++) b.userMessage(`m${i}`);
    const w = computeWork(b.events);
    expect(w.kind).toBe('start');
    if (w.kind === 'start') expect([...w.inputSeqs]).toEqual([1, 2, 3, 4, 5]);
  });
});
