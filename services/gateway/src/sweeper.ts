// Sweeper (A-01 §7.4, O-6, I-9, I-11, B-3): the gateway's only background task, every 15 s.
// Task 1 re-rings the doorbell for sessions with unconsumed input (W1: oldest unconsumed waited > 10 s, no open run)
//        or a silent open run (W2: no harness event for > 45 s). It looks at the tracking columns, NEVER at status.
// Task 2 back-fills booking.confirmed for tickets older than 5 s whose event is missing (same idempotency key as
//        the confirm path, so it is written at most once). Back-fills never ring the doorbell (D-39).
// A Redis lock (SET sweeper:lock NX PX 14000) keeps multiple gateway replicas from sweeping at once.
import { randomUUID } from 'node:crypto';
import { SWEEP_PERIOD_MS } from '@fb/contracts/server';
import type { Logger } from '@fb/platform/log';
import type { Redis } from '@fb/platform/redis';
import { generateTraceparent, traceIdFromTraceparent } from '@fb/platform/trace';
import { writeBookingConfirmed } from './booking.ts';
import { q, type Pool } from './db.ts';
import type { Doorbell, Notifier } from './doorbell.ts';
import { TICKET_COLUMNS, ticketView } from './views.ts';

export const SWEEPER_LOCK_KEY = 'sweeper:lock';
export const SWEEPER_LOCK_PX = 14_000;
export const W1_SECONDS = 10;
export const W2_SECONDS = 45;
export const TICKET_GRACE_SECONDS = 5;
/** consecutive rounds after which a still-stuck session is logged as an error (20 x 15 s = 5 min) */
export const STUCK_ROUNDS = 20;

export interface SweeperDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly doorbell: Doorbell;
  readonly notifier: Notifier;
  readonly log: Logger;
}

export interface SweepReport {
  readonly locked: boolean;
  readonly rung: string[];
  readonly backfilled: string[];
}

export class Sweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly stuck = new Map<string, number>();
  private readonly owner = randomUUID();

  private readonly d: SweeperDeps;
  constructor(d: SweeperDeps) {
    this.d = d;
  }

  start(periodMs = SWEEP_PERIOD_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), periodMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.d.log.error({ err: (err as Error).message }, 'sweeper round failed');
    } finally {
      this.running = false;
    }
  }

  /** One round. Exposed for tests; `nowMs` only feeds the scan jobId bucket. */
  async runOnce(nowMs = Date.now()): Promise<SweepReport> {
    const got = await this.d.redis.set(SWEEPER_LOCK_KEY, this.owner, 'PX', SWEEPER_LOCK_PX, 'NX');
    if (got !== 'OK') return { locked: false, rung: [], backfilled: [] };

    const traceparent = generateTraceparent();
    const traceId = traceIdFromTraceparent(traceparent) ?? '0'.repeat(32);

    // ---- task 1: doorbell recovery for unconsumed input ----
    const due = await q<{ id: string }>(
      this.d.pool,
      `SELECT id FROM app.sessions
        WHERE (last_user_seq > consumed_up_to_seq AND open_run_id IS NULL
               AND oldest_unconsumed_at < now() - make_interval(secs => $1))
           OR (open_run_id IS NOT NULL
               AND COALESCE(last_agent_event_at, updated_at) < now() - make_interval(secs => $2))
        LIMIT 200`,
      [W1_SECONDS, W2_SECONDS],
    );
    const rung: string[] = [];
    const seen = new Set<string>();
    for (const { id } of due) {
      seen.add(id);
      if (await this.d.doorbell.ringForSweep(id, nowMs, traceparent)) rung.push(id);
      const n = (this.stuck.get(id) ?? 0) + 1;
      this.stuck.set(id, n);
      if (n >= STUCK_ROUNDS && n % STUCK_ROUNDS === 0) {
        this.d.log.error({ sessionId: id, rounds: n }, 'session still has unprocessed input; is harness down?');
      }
    }
    for (const id of [...this.stuck.keys()]) if (!seen.has(id)) this.stuck.delete(id);

    // ---- task 2: booking.confirmed reconciliation ----
    const tickets = await q(
      this.d.pool,
      `SELECT ${TICKET_COLUMNS.split(', ')
        .map((c) => `t.${c}`)
        .join(', ')}
         FROM app.tickets t
        WHERE t.booked_at < now() - make_interval(secs => $1)
          AND NOT EXISTS (SELECT 1 FROM app.events e
                           WHERE e.session_id = t.session_id AND e.idempotency_key = 'booking:' || t.quote_id)
        LIMIT 100`,
      [TICKET_GRACE_SECONDS],
    );
    const backfilled: string[] = [];
    for (const row of tickets) {
      const ticket = ticketView(row);
      try {
        const r = await writeBookingConfirmed(this.d, ticket, traceId);
        if (r.kind === 'created') backfilled.push(ticket.quoteId);
      } catch (err) {
        this.d.log.error({ quoteId: ticket.quoteId, err: (err as Error).message }, 'booking.confirmed backfill failed');
      }
    }

    this.d.log.info({ sessions: due.length, rung: rung.length, backfilled: backfilled.length }, 'sweeper round');
    return { locked: true, rung, backfilled };
  }
}
