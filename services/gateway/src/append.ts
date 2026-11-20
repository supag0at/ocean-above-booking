// The one place that INSERTs into app.events (A-01 §3.3: only gateway writes events; §5.1 steps 2/6/7; §6.4).
// Callers run inside a transaction and have already locked the session row with lockSession().
// Every write updates seq, the consumption-tracking columns and the display status in the same transaction,
// so "an unconsumed user.message exists" is persisted atomically with the message itself (B-3).
import { EVENT_ACTOR, canonicalJson, type EventType } from '@fb/contracts/server';
import type { SessionStatus } from '@fb/contracts/web';
import { num, type PgClient } from './db.ts';
import { EVENT_COLUMNS, displayStatus, eventRowFromDb, type EventRow } from './views.ts';

export interface LockedSession {
  id: string;
  userId: string;
  title: string | null;
  lastSeq: number;
  lastUserSeq: number;
  consumedUpToSeq: number;
  openRunId: string | null;
  lastRunOutcome: string | null;
  maxFenceSeen: number;
  status: SessionStatus;
}

/** SELECT … FOR UPDATE: serialises every write of one session (A-01 §5.1 step 2). Null when absent. */
export async function lockSession(c: PgClient, sessionId: string): Promise<LockedSession | null> {
  const r = await c.query(
    `SELECT id, user_id, title, last_seq, last_user_seq, consumed_up_to_seq, open_run_id, last_run_outcome,
            max_fence_seen, status
       FROM app.sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: row.title === null ? null : String(row.title),
    lastSeq: num(row.last_seq),
    lastUserSeq: num(row.last_user_seq),
    consumedUpToSeq: num(row.consumed_up_to_seq),
    openRunId: row.open_run_id === null ? null : String(row.open_run_id),
    lastRunOutcome: row.last_run_outcome === null ? null : String(row.last_run_outcome),
    maxFenceSeen: num(row.max_fence_seen),
    status: row.status as SessionStatus,
  };
}

export type Source = 'public' | 'harness' | 'system';

export interface AppendInput {
  type: EventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  traceId: string;
  source: Source;
  /** harness writes: the fence that passed checkFence (A-01 §5.1 step 7: max_fence_seen = GREATEST(…, f)) */
  fence?: number;
}

export type AppendResult =
  | { kind: 'created'; event: EventRow; status: SessionStatus; statusChanged: boolean }
  | { kind: 'duplicate'; event: EventRow }
  | { kind: 'conflict'; event: EventRow };

const TITLE_CHARS = 40;

export async function appendEvent(c: PgClient, s: LockedSession, input: AppendInput): Promise<AppendResult> {
  // step 6: idempotency (canonicalJson of type + payload, I-5)
  const ex = await c.query(`SELECT ${EVENT_COLUMNS} FROM app.events WHERE session_id = $1 AND idempotency_key = $2`, [
    s.id,
    input.idempotencyKey,
  ]);
  const existing = ex.rows[0] as Record<string, unknown> | undefined;
  if (existing) {
    const event = eventRowFromDb(existing);
    const same = event.type === input.type && canonicalJson(event.payload) === canonicalJson(input.payload as unknown);
    return { kind: same ? 'duplicate' : 'conflict', event };
  }

  // step 7: seq = last_seq + 1; actor from the call source via the type table, never from the writer (A-01 §6.2)
  const seq = s.lastSeq + 1;
  const ins = await c.query(
    `INSERT INTO app.events (session_id, seq, type, actor, trace_id, idempotency_key, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING ${EVENT_COLUMNS}`,
    [
      s.id,
      seq,
      input.type,
      EVENT_ACTOR[input.type],
      input.traceId,
      input.idempotencyKey,
      JSON.stringify(input.payload),
    ],
  );
  const event = eventRowFromDb(ins.rows[0] as Record<string, unknown>);

  // §6.4 consumption tracking
  const next = { ...s, lastSeq: seq };
  const sets: string[] = ['last_seq = $2', 'updated_at = now()'];
  const vals: unknown[] = [s.id, seq];
  const set = (col: string, value: unknown, cast = ''): void => {
    vals.push(value);
    sets.push(`${col} = $${vals.length}${cast}`);
  };

  switch (input.type) {
    case 'user.message': {
      next.lastUserSeq = seq;
      set('last_user_seq', seq);
      sets.push('last_user_at = now()', 'oldest_unconsumed_at = COALESCE(oldest_unconsumed_at, now())');
      if (s.title === null) {
        const text = String(input.payload.text ?? '');
        set('title', [...text].slice(0, TITLE_CHARS).join(''));
      }
      break;
    }
    case 'agent.run_started': {
      const upTo = Math.max(s.consumedUpToSeq, Number(input.payload.consumedUpToSeq));
      next.consumedUpToSeq = upTo;
      next.openRunId = String(input.payload.runId);
      set('consumed_up_to_seq', upTo);
      set('open_run_id', next.openRunId);
      if (next.lastUserSeq > upTo) {
        // earliest still-unconsumed user.message (tail of the session, primary-key range scan)
        vals.push(upTo);
        sets.push(
          `oldest_unconsumed_at = (SELECT min(ts) FROM app.events WHERE session_id = $1 AND seq > $${vals.length}
             AND type = 'user.message')`,
        );
      } else {
        sets.push('oldest_unconsumed_at = NULL');
      }
      break;
    }
    case 'agent.run_resumed':
      next.openRunId = String(input.payload.runId);
      set('open_run_id', next.openRunId);
      break;
    case 'agent.run_completed':
    case 'agent.run_failed': {
      const outcome = input.type === 'agent.run_completed' ? 'completed' : 'failed';
      next.openRunId = null;
      next.lastRunOutcome = outcome;
      sets.push('open_run_id = NULL');
      set('last_run_outcome', outcome);
      break;
    }
    default:
      // quote.offered, agent.message, guard_violation, context_compacted, booking.*: no tracking change
      break;
  }
  if (input.source === 'harness') sets.push('last_agent_event_at = now()');
  if (input.fence !== undefined) {
    next.maxFenceSeen = Math.max(s.maxFenceSeen, input.fence);
    set('max_fence_seen', next.maxFenceSeen);
  }
  const status = displayStatus(next);
  set('status', status);
  await c.query(`UPDATE app.sessions SET ${sets.join(', ')} WHERE id = $1`, vals);

  // keep the caller's locked snapshot current (several appends may share one transaction)
  const statusChanged = status !== s.status;
  Object.assign(s, next, { status });
  return { kind: 'created', event, status, statusChanged };
}
