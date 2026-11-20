// A deliberately minimal harness stand-in for the invariant tests (A-01 §7.4): a real BullMQ worker on
// `harness-wake` (harness ACL user) that, per wake job, takes a fresh fence, resumes an orphaned open run, and starts
// one run over ALL pending user.messages. It has no lease loop and no "re-check after release" (A-02 §3.1 step 2),
// so any input that arrives while it is busy is only picked up again through a new doorbell — i.e. the sweeper.
import { Worker } from 'bullmq';
import type { Redis } from '@fb/platform/redis';
import type { Harness } from './client.ts';
import { newRun, runCompleted, runStarted } from './fixtures.ts';

export interface SimRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly inputSeqs: number[];
  readonly at: number;
}
export interface SimResume {
  readonly sessionId: string;
  readonly runId: string;
  readonly fence: number;
  readonly at: number;
}

interface Ev {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export class SimHarness {
  readonly runs: SimRun[] = [];
  readonly resumes: SimResume[] = [];
  readonly wakes: { sessionId: string; jobId: string; at: number }[] = [];
  readonly errors: string[] = [];
  /** per-session time a started run stays open (simulates a long LLM turn) */
  readonly holdMs = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly worker: Worker;
  private readonly fenceRedis: Redis;
  private readonly h: Harness;

  constructor(o: { connection: Redis; fenceRedis: Redis; harness: Harness }) {
    this.fenceRedis = o.fenceRedis;
    this.h = o.harness;
    this.worker = new Worker(
      'harness-wake',
      async (job) => {
        const sessionId = String((job.data as { sessionId: string }).sessionId);
        this.wakes.push({ sessionId, jobId: String(job.id), at: Date.now() });
        await this.handle(sessionId);
      },
      { connection: o.connection, concurrency: 20 },
    );
    this.worker.on('error', (err) => {
      if (this.errors.length < 100) this.errors.push(`worker: ${err.message}`);
    });
  }

  private async events(sessionId: string): Promise<Ev[]> {
    const out: Ev[] = [];
    for (let after = 0; ;) {
      const r = await this.h.req('GET', `/internal/v1/sessions/${sessionId}/events?afterSeq=${after}`);
      if (r.status !== 200) throw new Error(`getEvents ${r.status}`);
      out.push(...(r.body.events as Ev[]));
      if (!r.body.hasMore) return out;
      after = out.at(-1)!.seq;
    }
  }

  private async emit(sessionId: string, fence: number, ev: { type: string; payload: unknown; idempotencyKey: string }) {
    const r = await this.h.emit(sessionId, fence, ev);
    if (r.status !== 201 && r.status !== 200)
      throw new Error(`emit ${ev.type} -> ${r.status} ${JSON.stringify(r.body)}`);
  }

  private async handle(sessionId: string): Promise<void> {
    if (this.busy.has(sessionId)) return; // "lease held": this doorbell is swallowed
    this.busy.add(sessionId);
    try {
      const fence = await this.fenceRedis.incr(`lease:fence:${sessionId}`);
      const evs = await this.events(sessionId);
      const open = new Map<string, number>(); // runId -> attempt
      let consumed = 0;
      for (const e of evs) {
        const runId = String(e.payload.runId ?? '');
        if (e.type === 'agent.run_started') {
          open.set(runId, 1);
          consumed = Math.max(consumed, Number(e.payload.consumedUpToSeq));
        } else if (e.type === 'agent.run_resumed') open.set(runId, Number(e.payload.attempt));
        else if (e.type === 'agent.run_completed' || e.type === 'agent.run_failed') open.delete(runId);
      }
      for (const [runId, attempt] of open) {
        await this.emit(sessionId, fence, {
          type: 'agent.run_resumed',
          idempotencyKey: `run:${runId}:resumed:${attempt + 1}`,
          payload: { runId, attempt: attempt + 1 },
        });
        this.resumes.push({ sessionId, runId, fence, at: Date.now() });
        await this.emit(sessionId, fence, runCompleted(runId));
      }
      const pending = evs.filter((e) => e.type === 'user.message' && e.seq > consumed).map((e) => e.seq);
      if (pending.length === 0) return;
      const runId = newRun();
      await this.emit(sessionId, fence, runStarted(runId, pending));
      this.runs.push({ sessionId, runId, inputSeqs: pending, at: Date.now() });
      const hold = this.holdMs.get(sessionId) ?? 0;
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      await this.emit(sessionId, fence, runCompleted(runId));
    } catch (err) {
      this.errors.push(`${sessionId}: ${(err as Error).message}`);
    } finally {
      this.busy.delete(sessionId);
    }
  }

  close(): Promise<void> {
    return this.worker.close(true);
  }
}
