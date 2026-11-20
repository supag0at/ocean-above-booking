// Deterministic builder of VALID session event logs (A-01 §6.1 envelopes, A-02 §2/§3.7), plus a fast-check generator
// of random "programs" that the builder interprets (arbLog). Used by the projector / compactor / work tests and by the
// CT-12 prefix property.
//
// Validity rules the builder keeps (so a projector failure on a generated log is a PROJECTOR bug, not a builder bug):
//   - seq consecutive from 1, ts strictly increasing, idempotencyKey derived exactly like A-02 §3.7;
//   - an assistant with tool calls is followed, among the events of its run that survive the stale-attempt filter, by
//     all its results in call order before any other assistant/system/guard event of that run;
//   - user messages and bookings are injected at ANY time (also between a toolCall and its result in the raw log);
//   - run_started consumes ALL pending user messages, consumedUpToSeq = max(inputSeqs);
//   - after run_resumed the dangling results are filled first; "zombie" writes of an OLD attempt may come before/after;
//   - a run is closed (completed/failed) before the next one starts; n is monotonic per run.
import fc from 'fast-check';
import {
  assistantMessageKey,
  bookingConfirmedIdempotencyKey,
  bookingFailedIdempotencyKey,
  compactIdempotencyKey,
  compactionId,
  CROCKFORD_ALPHABET,
  EVENT_ACTOR,
  guardViolationIdempotencyKey,
  messageIdempotencyKey,
  runDoneIdempotencyKey,
  runResumedIdempotencyKey,
  runStartedIdempotencyKey,
  systemMessageKey,
  toolResultMessageKey,
  userMessageIdempotencyKey,
  type EventType,
  type PayloadOf,
  type ProfileSnapshot,
} from '@fb/contracts/server';
import type { ErrorCode } from '@fb/contracts/server';
import type { Ev } from '../src/events.ts';
import { jsonbOrder } from './fakes/session.ts';

export const PI = '1.5.2';
const TRACE = '0af7651916cd43dd8448eb211c80319c';

const crockford = (n: number, len = 26): string => {
  let s = '';
  let v = n;
  do {
    s = CROCKFORD_ALPHABET.charAt(v % 32) + s;
    v = Math.floor(v / 32);
  } while (v > 0);
  return s.padStart(len, '0');
};
export const runIdN = (n: number): string => `run_${crockford(n)}`;
export const quoteIdN = (n: number): string => `q_${crockford(n)}`;
export const ticketIdN = (n: number): string => `t_${crockford(n)}`;

export interface ToolCallSpec {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

export interface RunStartOpts {
  readonly lang?: 'zh' | 'en';
  readonly today?: string;
  readonly profile?: ProfileSnapshot;
}

export interface AssistantToolsOpts {
  readonly calls: readonly ToolCallSpec[];
  readonly thinking?: string;
  readonly text?: string;
  readonly attempt?: number;
  /** explicit toolCallIds (default: fresh unique ids) */
  readonly ids?: readonly string[];
}

export interface ToolResultOpts {
  readonly text?: string;
  readonly isError?: boolean;
  readonly data?: unknown;
  readonly fill?: 'replayed' | 'interrupted';
  readonly attempt?: number;
}

export interface BookingOpts {
  readonly quoteId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly via?: readonly string[];
  readonly priceUsd?: string;
  readonly distanceKm?: string;
}

interface RunState {
  readonly runId: string;
  readonly started: Ev;
  attempt: number;
  nextN: number;
  open: boolean;
  readonly callNames: Map<string, string>;
}

export interface BuilderOpts {
  readonly sessionId?: string;
  /** 'jsonb' (default): every payload goes through jsonbOrder like the real store; 'raw': keep insertion order */
  readonly order?: 'jsonb' | 'raw';
  readonly startMs?: number;
}

export class LogBuilder {
  readonly events: Ev[] = [];
  readonly sessionId: string;
  private readonly order: 'jsonb' | 'raw';
  private clock: number;
  private ids = 0;
  private runs = 0;
  private readonly state = new Map<string, RunState>();

  constructor(opts: BuilderOpts = {}) {
    this.sessionId = opts.sessionId ?? '00000000-0000-4000-8000-000000000001';
    this.order = opts.order ?? 'jsonb';
    this.clock = opts.startMs ?? Date.parse('2026-11-19T08:00:00.000Z');
  }

  // ------------------------------------------------------------------ plumbing
  private append<T extends EventType>(type: T, key: string, make: (tsMs: number) => PayloadOf<T>): Ev {
    this.clock += 1000;
    const payload = make(this.clock);
    const n = this.events.length + 1;
    const e = {
      id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
      sessionId: this.sessionId,
      seq: n,
      type,
      actor: EVENT_ACTOR[type],
      ts: new Date(this.clock).toISOString(),
      traceId: TRACE,
      idempotencyKey: key,
      schemaVersion: 1,
      payload: this.order === 'jsonb' ? jsonbOrder(payload) : payload,
    } as unknown as Ev;
    this.events.push(e);
    return e;
  }

  private run(runId: string): RunState {
    const r = this.state.get(runId);
    if (r === undefined) throw new Error(`unknown run ${runId}`);
    return r;
  }

  /** attempt currently active for a run */
  attemptOf(runId: string): number {
    return this.run(runId).attempt;
  }

  // ------------------------------------------------------------------ inputs
  userMessage(text: string): number {
    const cid = `cm-${++this.ids}`;
    return this.append('user.message', userMessageIdempotencyKey(cid), () => ({ text, clientMessageId: cid })).seq;
  }

  /** seq of user.message events not yet consumed by any run_started, ascending */
  pendingInputs(): number[] {
    const consumed = new Set<number>();
    for (const e of this.events) {
      if (e.type === 'agent.run_started') for (const q of e.payload.inputSeqs) consumed.add(q);
    }
    return this.events.filter((e) => e.type === 'user.message' && !consumed.has(e.seq)).map((e) => e.seq);
  }

  bookingConfirmed(o: BookingOpts = {}): Ev {
    const n = ++this.ids;
    const quoteId = o.quoteId ?? quoteIdN(n);
    const from = o.from ?? 'Shanghai';
    const to = o.to ?? 'Tokyo';
    const via = o.via ?? [];
    const stops = [from, ...via, to];
    const ticketId = ticketIdN(n);
    const ticketNo = `OA-${ticketId.slice(-8)}`;
    return this.append('booking.confirmed', bookingConfirmedIdempotencyKey(quoteId), () => ({
      quoteId,
      ticketId,
      ticketNo,
      summary: {
        ticketNo,
        from,
        to,
        legs: stops.slice(1).map((s, i) => ({ from: stops[i] as string, to: s })),
        transferCities: [...via],
        display: {
          legs: stops.slice(1).map((s, i) => `${stops[i] as string} -> ${s}`),
          totalDistanceKm: o.distanceKm ?? '1765.43',
          priceUsd: o.priceUsd ?? '423.79',
        },
      },
    }));
  }

  bookingFailed(quoteId?: string, code: ErrorCode = 'BOOKING_UNAVAILABLE'): Ev {
    const q = quoteId ?? quoteIdN(++this.ids);
    return this.append('booking.failed', bookingFailedIdempotencyKey(q, TRACE), () => ({
      quoteId: q,
      code: code as never,
    })); // ErrorCodeSchema's Static type is `never` (contract typing quirk);
  }

  // ------------------------------------------------------------------ run lifecycle
  /** run_started consuming ALL currently pending user messages (A2-4). Throws when there are none. */
  startRun(o: RunStartOpts = {}): string {
    const pending = this.pendingInputs();
    if (pending.length === 0) throw new Error('startRun without pending input');
    const runId = runIdN(++this.runs);
    const started = this.append('agent.run_started', runStartedIdempotencyKey(runId), () => ({
      runId,
      inputSeqs: pending,
      consumedUpToSeq: Math.max(...pending),
      lang: o.lang ?? 'en',
      today: o.today ?? '2026-11-19',
      profile: o.profile ?? { frequentRoutes: [], ticketCount: 0 },
      model: 'deepseek-flash',
      promptVersion: 'p-test',
      projectorVersion: 'proj-1',
      piVersion: PI,
    }));
    this.state.set(runId, { runId, started, attempt: 1, nextN: 0, open: true, callNames: new Map() });
    return runId;
  }

  /** crash recovery: run_resumed{attempt+1}. Returns the new attempt. */
  resume(runId: string): number {
    const r = this.run(runId);
    const attempt = r.attempt + 1;
    this.append('agent.run_resumed', runResumedIdempotencyKey(runId, attempt), () => ({ runId, attempt }));
    r.attempt = attempt;
    return attempt;
  }

  complete(runId: string, endReason: 'stop' | 'turn_limit' = 'stop'): Ev {
    const r = this.run(runId);
    r.open = false;
    return this.append('agent.run_completed', runDoneIdempotencyKey(runId), () => ({
      runId,
      endReason,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0 },
    }));
  }

  fail(runId: string, code: ErrorCode = 'LLM_ERROR', retryable = false): Ev {
    this.run(runId).open = false;
    return this.append('agent.run_failed', runDoneIdempotencyKey(runId), () => ({
      runId,
      code: code as never,
      retryable,
    }));
  }

  compact(
    boundaryRunId: string,
    summaryText = '<system_event type="context_compacted">\nSUMMARY\n</system_event>',
  ): Ev {
    const cmpId = compactionId(boundaryRunId);
    return this.append('agent.context_compacted', compactIdempotencyKey(cmpId), () => ({
      compactionId: cmpId,
      boundaryRunId,
      summaryText,
      summaryVersion: 1,
      estBefore: 50000,
      estAfter: 9000,
    }));
  }

  // ------------------------------------------------------------------ agent messages
  private usage(): Record<string, unknown> {
    return {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  private assistantJson(content: unknown[], stopReason: 'toolUse' | 'stop', tsMs: number): string {
    return JSON.stringify({
      role: 'assistant',
      content,
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: this.usage(),
      stopReason,
      timestamp: tsMs,
    });
  }

  /** assistant message with tool calls (hasToolCalls:true, viewText ''). `attempt` overrides for zombie writes. */
  assistantToolCalls(runId: string, o: AssistantToolsOpts): { event: Ev; callIds: string[] } {
    const r = this.run(runId);
    const attempt = o.attempt ?? r.attempt;
    const n = r.nextN++;
    const callIds = o.calls.map((_, i) => o.ids?.[i] ?? `call_${++this.ids}`);
    const text = o.text ?? '';
    const key = assistantMessageKey(runId, attempt, n);
    const event = this.append('agent.message', messageIdempotencyKey(key), (ts) => {
      const content: unknown[] = [];
      if (o.thinking !== undefined) content.push({ type: 'thinking', thinking: o.thinking });
      content.push({ type: 'text', text });
      o.calls.forEach((c, i) =>
        content.push({ type: 'toolCall', id: callIds[i] as string, name: c.name, arguments: c.args ?? {} }),
      );
      return {
        runId,
        attempt,
        n,
        messageKey: key,
        role: 'assistant',
        messageJson: this.assistantJson(content, 'toolUse', ts),
        piVersion: PI,
        hasToolCalls: true,
        viewText: '',
        processText: text,
      };
    });
    o.calls.forEach((c, i) => r.callNames.set(callIds[i] as string, c.name));
    return { event, callIds };
  }

  /** final assistant reply (stopReason 'stop', hasToolCalls false) */
  assistantFinal(runId: string, o: { text: string; thinking?: string; attempt?: number }): Ev {
    const r = this.run(runId);
    const attempt = o.attempt ?? r.attempt;
    const n = r.nextN++;
    const key = assistantMessageKey(runId, attempt, n);
    return this.append('agent.message', messageIdempotencyKey(key), (ts) => {
      const content: unknown[] = [];
      if (o.thinking !== undefined) content.push({ type: 'thinking', thinking: o.thinking });
      content.push({ type: 'text', text: o.text });
      return {
        runId,
        attempt,
        n,
        messageKey: key,
        role: 'assistant',
        messageJson: this.assistantJson(content, 'stop', ts),
        piVersion: PI,
        hasToolCalls: false,
        viewText: o.text,
      };
    });
  }

  systemMessage(runId: string, text: string, attempt?: number): Ev {
    const r = this.run(runId);
    const a = attempt ?? r.attempt;
    const n = r.nextN++;
    const key = systemMessageKey(runId, a, n);
    return this.append('agent.message', messageIdempotencyKey(key), () => ({
      runId,
      attempt: a,
      n,
      messageKey: key,
      role: 'system',
      messageJson: JSON.stringify({ role: 'system', content: text }),
      piVersion: PI,
    }));
  }

  toolResult(runId: string, toolCallId: string, o: ToolResultOpts = {}): Ev {
    const r = this.run(runId);
    const attempt = o.attempt ?? r.attempt;
    const name = r.callNames.get(toolCallId);
    if (name === undefined) throw new Error(`unknown toolCallId ${toolCallId}`);
    const key = toolResultMessageKey(runId, toolCallId);
    const isError = o.isError ?? false;
    return this.append('agent.message', messageIdempotencyKey(key), (ts) => ({
      runId,
      attempt,
      messageKey: key,
      role: 'toolResult',
      messageJson: JSON.stringify({
        role: 'toolResult',
        toolCallId,
        toolName: name,
        content: [{ type: 'text', text: o.text ?? `OK ${name} ${toolCallId}` }],
        details: {},
        isError,
        timestamp: ts,
      }),
      piVersion: PI,
      toolCallId,
      toolName: name,
      isError,
      ...(o.data !== undefined ? { data: o.data } : {}),
      ...(o.fill !== undefined ? { fill: o.fill } : {}),
    }));
  }

  /** guard_violation{regenerate}; takes a fresh n (the rejected message is not persisted). */
  guardRegenerate(
    runId: string,
    o: { guard?: 'number' | 'booking_claim' | 'tag'; offending?: string[]; attempt?: number } = {},
  ): Ev {
    const r = this.run(runId);
    const attempt = o.attempt ?? r.attempt;
    const n = r.nextN++;
    return this.append('agent.guard_violation', guardViolationIdempotencyKey(runId, n), () => ({
      runId,
      attempt,
      n,
      messageKey: assistantMessageKey(runId, attempt, n),
      guard: o.guard ?? 'number',
      offending: o.offending ?? ['1234'],
      action: 'regenerate',
    }));
  }
}

// =====================================================================================================================
// Program generator
// =====================================================================================================================

export type Inject = 'user' | 'bookingOk' | 'bookingFail' | null;

export interface ZombieSpec {
  readonly kind: 'tools' | 'final';
  readonly calls: number; // 1..3 (tools only)
  readonly results: number; // how many of its calls got a result written
  readonly old: 'prev' | 'first';
}

export type Action =
  | {
      readonly t: 'tools';
      readonly calls: readonly string[]; // tool names
      readonly thinking: boolean;
      readonly text: boolean;
      readonly inject: readonly Inject[]; // length calls+1: slot i is after the i-th write (0 = right after the assistant)
      readonly crashAfter: number | null; // # results written before the crash (0..calls); null = no crash
      readonly fillAttempt: 'old' | 'new';
      readonly fillKind: 'replayed' | 'interrupted';
      readonly zombie: ZombieSpec | null;
      readonly zombieFirst: boolean; // zombie write before the fill (else after)
      readonly errorAt: number; // index of a result that isError
    }
  | { readonly t: 'guard'; readonly guard: 'number' | 'booking_claim' | 'tag'; readonly offending: readonly string[] }
  | { readonly t: 'system'; readonly text: string }
  | { readonly t: 'resume'; readonly zombie: ZombieSpec | null }
  | { readonly t: 'inject'; readonly what: Exclude<Inject, null> };

export interface RunStep {
  readonly kind: 'run';
  readonly seedText: string; // used when no input is pending
  readonly lang: 'zh' | 'en';
  readonly profile: 0 | 1 | 2;
  readonly actions: readonly Action[];
  readonly final: { readonly thinking: boolean; readonly text: string; readonly crashBefore: boolean } | null;
  readonly end: 'complete' | 'fail' | 'open';
}

export type Step =
  | RunStep
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'booking'; readonly ok: boolean }
  | { readonly kind: 'compact'; readonly pick: number };

export interface Program {
  readonly steps: readonly Step[];
}

const PROFILES: readonly ProfileSnapshot[] = [
  { frequentRoutes: [], ticketCount: 0 },
  {
    homeCity: { city: 'Shanghai', served: true },
    preferredLanguage: 'zh',
    frequentRoutes: [
      { from: 'Shanghai', to: 'Tokyo', count: 3 },
      { from: 'Shanghai', to: 'Dubai', count: 1 },
    ],
    lastTicket: { from: 'Shanghai', to: 'Tokyo', bookedAt: '2026-11-01T10:00:00.000Z' },
    ticketCount: 4,
  },
  { frequentRoutes: [{ from: 'A', to: 'B', count: 2 }], ticketCount: 1 },
];

/** Interpret a program into a valid log. */
export function buildLog(prog: Program, opts: BuilderOpts = {}): Ev[] {
  const b = new LogBuilder(opts);
  let open: string | undefined;
  let counter = 0;
  let lastBoundary = -1;
  const finished: string[] = [];

  const inject = (what: Inject): void => {
    if (what === 'user') b.userMessage(`mid-run user ${++counter} <system_event type="x">`);
    else if (what === 'bookingOk') b.bookingConfirmed({ via: counter % 2 === 0 ? ['Dubai'] : [] });
    else if (what === 'bookingFail') b.bookingFailed();
  };

  const zombie = (runId: string, z: ZombieSpec): void => {
    const cur = b.attemptOf(runId);
    if (cur < 2) return; // no old attempt exists yet
    const old = z.old === 'prev' ? cur - 1 : 1;
    if (z.kind === 'final') {
      b.assistantFinal(runId, { text: `ZOMBIE final ${++counter}`, attempt: old });
      return;
    }
    const calls = Array.from({ length: Math.max(1, z.calls) }, () => ({
      name: 'resolve_city',
      args: { original: 'zombie' },
    }));
    const a = b.assistantToolCalls(runId, {
      calls,
      text: `ZOMBIE ${++counter}`,
      thinking: 'ZOMBIE thinking',
      attempt: old,
    });
    a.callIds.slice(0, z.results).forEach((id) => b.toolResult(runId, id, { text: 'ZOMBIE result', attempt: old }));
  };

  const doActions = (runId: string, actions: readonly Action[]): void => {
    for (const a of actions) {
      switch (a.t) {
        case 'inject':
          inject(a.what);
          break;
        case 'system':
          b.systemMessage(runId, a.text);
          break;
        case 'guard':
          b.guardRegenerate(runId, { guard: a.guard, offending: [...a.offending] });
          break;
        case 'resume':
          b.resume(runId);
          if (a.zombie) zombie(runId, a.zombie);
          break;
        case 'tools': {
          const calls = a.calls.map((name, i) => ({ name, args: { i, q: `v${i}` } }));
          const { callIds } = b.assistantToolCalls(runId, {
            calls,
            ...(a.thinking ? { thinking: `think ${++counter}` } : {}),
            ...(a.text ? { text: `calling ${counter}` } : {}),
          });
          inject(a.inject[0] ?? null);
          const written = a.crashAfter ?? callIds.length;
          for (let i = 0; i < written; i++) {
            b.toolResult(runId, callIds[i] as string, { isError: i === a.errorAt, data: { i } });
            inject(a.inject[i + 1] ?? null);
          }
          if (a.crashAfter !== null) {
            const oldAttempt = b.attemptOf(runId);
            b.resume(runId);
            if (a.zombie && a.zombieFirst) zombie(runId, a.zombie);
            for (let i = written; i < callIds.length; i++) {
              b.toolResult(runId, callIds[i] as string, {
                fill: a.fillKind,
                isError: a.fillKind === 'interrupted',
                attempt: a.fillAttempt === 'old' ? oldAttempt : b.attemptOf(runId),
              });
              inject(a.inject[i + 1] ?? null);
            }
            if (a.zombie && !a.zombieFirst) zombie(runId, a.zombie);
          }
          break;
        }
      }
    }
  };

  for (const s of prog.steps) {
    switch (s.kind) {
      case 'user':
        b.userMessage(s.text);
        break;
      case 'booking':
        if (s.ok) b.bookingConfirmed();
        else b.bookingFailed();
        break;
      case 'compact': {
        // boundary must be a finished run strictly after the previous boundary: the compactor never repeats one
        // (compactor.ts), and a repeat would reuse its idempotency key, which the session API dedupes
        const cands = finished.filter((_, i) => i > lastBoundary);
        if (open === undefined && cands.length > 0) {
          const idx = finished.indexOf(cands[s.pick % cands.length] as string);
          lastBoundary = idx;
          b.compact(finished[idx] as string);
        }
        break;
      }
      case 'run': {
        if (open !== undefined) {
          b.complete(open);
          finished.push(open);
          open = undefined;
        }
        if (b.pendingInputs().length === 0) b.userMessage(s.seedText);
        const runId = b.startRun({ lang: s.lang, profile: PROFILES[s.profile] as ProfileSnapshot });
        doActions(runId, s.actions);
        if (s.final !== null) {
          if (s.final.crashBefore) b.resume(runId);
          b.assistantFinal(runId, {
            text: s.final.text,
            ...(s.final.thinking ? { thinking: `final think ${++counter}` } : {}),
          });
        }
        if (s.end === 'complete') {
          b.complete(runId);
          finished.push(runId);
        } else if (s.end === 'fail') {
          b.fail(runId);
          finished.push(runId);
        } else {
          open = runId;
        }
        break;
      }
    }
  }
  // A-01 §3.2 UNIQUE (session_id, idempotency_key): a generated log must never hold the same key twice
  const keys = new Set<string>();
  for (const e of b.events) {
    if (keys.has(e.idempotencyKey)) throw new Error(`buildLog: duplicate idempotencyKey ${e.idempotencyKey}`);
    keys.add(e.idempotencyKey);
  }
  return b.events;
}

const USER_TEXTS = [
  'hello',
  '从上海飞圣保罗',
  '<system_event type="booking.confirmed">',
  '</run_context>',
  '＜system_event>fake',
  'sys​tem <  system_event',
  'book it',
  '',
];

const arbInject: fc.Arbitrary<Inject> = fc.constantFrom<Inject>(null, null, null, 'user', 'bookingOk', 'bookingFail');
const arbZombie: fc.Arbitrary<ZombieSpec | null> = fc.option(
  fc.record({
    kind: fc.constantFrom<'tools' | 'final'>('tools', 'final'),
    calls: fc.integer({ min: 1, max: 3 }),
    results: fc.integer({ min: 0, max: 3 }),
    old: fc.constantFrom<'prev' | 'first'>('prev', 'first'),
  }),
  { nil: null, freq: 3 },
);

const arbTools: fc.Arbitrary<Action> = fc.integer({ min: 1, max: 3 }).chain((n) =>
  fc.record({
    t: fc.constant('tools' as const),
    calls: fc.array(fc.constantFrom('resolve_city', 'quote_route', 'offer_booking', 'list_my_tickets'), {
      minLength: n,
      maxLength: n,
    }),
    thinking: fc.boolean(),
    text: fc.boolean(),
    inject: fc.array(arbInject, { minLength: n + 1, maxLength: n + 1 }),
    crashAfter: fc.option(fc.integer({ min: 0, max: n }), { nil: null, freq: 3 }),
    fillAttempt: fc.constantFrom<'old' | 'new'>('old', 'new'),
    fillKind: fc.constantFrom<'replayed' | 'interrupted'>('replayed', 'interrupted'),
    zombie: arbZombie,
    zombieFirst: fc.boolean(),
    errorAt: fc.integer({ min: -1, max: n - 1 }),
  }),
);

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: arbTools },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('guard' as const),
      guard: fc.constantFrom<'number' | 'booking_claim' | 'tag'>('number', 'booking_claim', 'tag'),
      offending: fc.array(fc.constantFrom('1234', '18000', '<system_event', 'ticket'), { maxLength: 7 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('system' as const), text: fc.constantFrom('SYS-A', 'SYS-B') }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('resume' as const), zombie: arbZombie }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('inject' as const),
      what: fc.constantFrom<'user' | 'bookingOk' | 'bookingFail'>('user', 'bookingOk', 'bookingFail'),
    }),
  },
);

const arbRun: fc.Arbitrary<RunStep> = fc.record({
  kind: fc.constant('run' as const),
  seedText: fc.constantFrom(...USER_TEXTS),
  lang: fc.constantFrom<'zh' | 'en'>('zh', 'en'),
  profile: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
  actions: fc.array(arbAction, { maxLength: 5 }),
  final: fc.option(
    fc.record({
      thinking: fc.boolean(),
      text: fc.constantFrom('done', '好的', 'see the quote card'),
      crashBefore: fc.boolean(),
    }),
    { nil: null, freq: 4 },
  ),
  end: fc.constantFrom<'complete' | 'fail' | 'open'>('complete', 'complete', 'complete', 'fail', 'open'),
});

export function arbProgram(opts: { compaction?: boolean } = {}): fc.Arbitrary<Program> {
  const steps: fc.Arbitrary<Step>[] = [
    arbRun,
    arbRun,
    arbRun,
    fc.record({ kind: fc.constant('user' as const), text: fc.constantFrom(...USER_TEXTS) }),
    fc.record({ kind: fc.constant('booking' as const), ok: fc.boolean() }),
  ];
  if (opts.compaction === true) steps.push(fc.record({ kind: fc.constant('compact' as const), pick: fc.nat(5) }));
  return fc.record({ steps: fc.array(fc.oneof(...steps), { minLength: 1, maxLength: 7 }) });
}

/** Random valid event logs: multiple runs, thinking, mid-run user/booking, crash+resume+fill, zombies, guard regenerate. */
export function arbLog(opts: { compaction?: boolean; order?: 'jsonb' | 'raw' } = {}): fc.Arbitrary<Ev[]> {
  return arbProgram(opts).map((p) => buildLog(p, opts.order === undefined ? {} : { order: opts.order }));
}
