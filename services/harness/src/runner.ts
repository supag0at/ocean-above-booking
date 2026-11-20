// harness job: lease → read log → computeWork → start / resume a run → write back → release → re-check (A-02 §3).
// Stateless across jobs: everything is derived from the event log on every (re)build.
import { RUN_LIMITS } from '@fb/contracts/flight';
import {
  assistantMessageKey,
  guardViolationIdempotencyKey,
  messageIdempotencyKey,
  newRunId,
  offerIdempotencyKey,
  runDoneIdempotencyKey,
  runResumedIdempotencyKey,
  runStartedIdempotencyKey,
  templateMessageKey,
  toolResultIdempotencyKey,
  toolResultMessageKey,
  compactIdempotencyKey,
  type EmitEventRequest,
  type Ending,
  type EphemeralEnvelope,
  type EphemeralType,
  type EphemeralPayloadOf,
  type PayloadOf,
  type ProfileSnapshot,
  type TemplateId,
  type UsageSummary,
} from '@fb/contracts/server';
import {
  ALL_TOOLS,
  EXECUTE_RETRY_DELAYS_MS,
  LLM_PREFIX_BLOCKED,
  LLM_PREFIX_ERROR,
  LLM_PREFIX_INTERRUPTED,
  LLM_TEXT_HANDS_UNAVAILABLE,
  SYS_PROFILE_SNAPSHOT,
  type ExecuteRequest,
  type ExecuteResponse,
} from '@fb/contracts/tools';
import { compact, type CompactOptions } from './compactor.ts';
import { findRunStarted, isType, lastSeq, mergeEvents, ofType, runIdOf, type Ev, type EvOf } from './events.ts';
import { allowSets, checkFinalReply, hasBookingConfirmed, tagGuard, type GuardHit } from './guards.ts';
import { chooseLang } from './lang.ts';
import { LeaseKeeper, type LeaseStore } from './lease.ts';
import {
  runAgent,
  templateAssistantMessage,
  toolResultMessage,
  type Llm,
  type RuntimeEvent,
  type ToolCallRequest,
  type ToolOutcome,
} from './llm/runtime.ts';
import { rawArgsErrors } from './llm/strict-check.ts';
import {
  PI_VERSION,
  type AgentMessage,
  type AssistantMessage,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
} from './llm/types.ts';
import type { EmitResult, EphemeralPublisher, Hands, SessionApi } from './ports.ts';
import { readAll } from './ports.ts';
import {
  ContextCorruptError,
  danglingToolCalls,
  keptAgentEvents,
  parseMessage,
  project,
  PROJECTOR_VERSION,
  toolCallsOf,
} from './projector.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';
import { failed, TEMPLATE_TEXT } from './templates.ts';
import { computeWork, findOpenRun } from './work.ts';

// ------------------------------------------------------------------------------------------------ config

export interface HarnessLimits {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly requestTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly restartLimit: number;
}

export interface HarnessDeps {
  readonly session: SessionApi;
  readonly hands: Hands;
  readonly publisher: EphemeralPublisher;
  readonly leases: LeaseStore;
  readonly llm: Llm;
  readonly limits?: Partial<HarnessLimits>;
  readonly renewMs?: number;
  /** backoff before LLM retries (§3.5): 1s, 3s */
  readonly llmRetryDelaysMs?: readonly number[];
  readonly handsRetryDelaysMs?: readonly number[];
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** compactor watermarks override (tests / V18 only; production uses D-57 H=40k, L=16k) */
  readonly compactOptions?: Pick<CompactOptions, 'high' | 'low'>;
  /** test hook: called with every LLM request payload (golden tests, §6.5 V1) */
  readonly onLlmPayload?: (payload: unknown) => void;
}

export const DEFAULT_LIMITS: HarnessLimits = { ...RUN_LIMITS };
const COST_PER_M = { input: 0.3, cacheRead: 0.006, output: 1.2 }; // §6.4: deepseek-flash peak price, constant

// ------------------------------------------------------------------------------------------------ errors

class LeaseLostError extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLostError';
  }
}
/** Someone else already wrote this run's ending (`run:{runId}:done` dedup/conflict): stop quietly. */
class RunEndedElsewhere extends Error {
  constructor() {
    super('run ended elsewhere');
    this.name = 'RunEndedElsewhere';
  }
}

export type JobOutcome = 'not_acquired' | 'idle' | 'lease_lost' | 'inactive';

// ------------------------------------------------------------------------------------------------ job loop

/** A-02 §3.4 onJob. Never rings the doorbell itself; loops in the same job and re-checks after release. */
export async function onJob(deps: HarnessDeps, sessionId: string, traceId = 'harness'): Promise<JobOutcome> {
  let lease = await deps.leases.acquire(sessionId);
  if (lease === null) return 'not_acquired';
  let events: Ev[];
  for (;;) {
    const keeper = new LeaseKeeper(deps.leases, lease, deps.renewMs);
    keeper.start();
    try {
      for (;;) {
        events = await readAll(deps.session, sessionId);
        const work = computeWork(events);
        if (work.kind === 'none') break;
        const ctx = new RunContext(deps, sessionId, keeper, events, traceId);
        const r = work.kind === 'start' ? await ctx.startRun(work.inputSeqs) : await ctx.resumeRun(work.runId);
        if (r === 'lost') return 'lease_lost';
        if (r === 'inactive') return 'inactive';
      }
    } finally {
      await keeper.stopAndRelease();
    }
    // released: check once more (closes the "checked, then released" window, §3.4)
    const tail = await readAll(deps.session, sessionId, lastSeq(events));
    if (computeWork(mergeEvents(events, tail)).kind === 'none') return 'idle';
    lease = await deps.leases.acquire(sessionId);
    if (lease === null) return 'idle'; // someone else is on it
  }
}

// ------------------------------------------------------------------------------------------------ run context

type RunResultKind = 'done' | 'lost' | 'inactive';

type Outcome =
  | { kind: 'completed' }
  | { kind: 'regenerate' }
  | { kind: 'replaced'; n: number; messageKey: string; hit: GuardHit }
  | { kind: 'turn_limit' }
  | { kind: 'error' }
  | { kind: 'request_timeout' }
  | { kind: 'length' }
  | { kind: 'run_timeout' }
  | { kind: 'hands_auth' }
  | { kind: 'corrupt' }
  | { kind: 'lost' }
  | { kind: 'ended_elsewhere' };

type EmitKind = 'strict' | 'toolResult' | 'done' | 'idempotent';

interface ToolRecord {
  readonly isError: boolean;
  readonly data?: unknown;
}

class RunContext {
  private readonly deps: HarnessDeps;
  private readonly sid: string;
  private readonly keeper: LeaseKeeper;
  private events: Ev[];
  private readonly traceId: string;
  private readonly limits: HarnessLimits;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  private runId = '';
  private attempt = 1;
  private token = '';
  private inputSeq = 1;
  private readonly unpersistedUsage: Usage[] = [];

  constructor(deps: HarnessDeps, sid: string, keeper: LeaseKeeper, events: Ev[], traceId: string) {
    this.deps = deps;
    this.sid = sid;
    this.keeper = keeper;
    this.events = events;
    this.traceId = traceId;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private log(msg: string, fields: Record<string, unknown> = {}): void {
    // never message bodies, tool arguments or profile contents (§6.6)
    this.deps.log?.(msg, { sessionId: this.sid, runId: this.runId, attempt: this.attempt, ...fields });
  }

  private async refresh(): Promise<void> {
    const tail = await readAll(this.deps.session, this.sid, lastSeq(this.events));
    this.events = mergeEvents(this.events, tail);
  }

  private get started(): EvOf<'agent.run_started'> {
    const s = findRunStarted(this.events, this.runId);
    if (s === undefined) throw new ContextCorruptError(`run_started of ${this.runId} missing`);
    return s;
  }

  // ---------------------------------------------------------------------------------------------- IO wrappers

  private async emit(req: EmitEventRequest, kind: EmitKind): Promise<'ok' | 'exists'> {
    if (this.keeper.lost) throw new LeaseLostError();
    let r: EmitResult;
    try {
      r = await this.deps.session.emit(this.sid, this.keeper.fence, req);
    } catch (e) {
      this.log('emit failed', { type: req.type, error: (e as Error).message });
      throw e;
    }
    if (r.status === 'stale') {
      this.keeper.markLost();
      throw new LeaseLostError();
    }
    if (r.status === 'created') return 'ok';
    const retried = r.retried;
    // §3.7 duplicate handling
    if (r.status === 'deduplicated' && retried) return 'ok'; // our own HTTP retry
    if (kind === 'toolResult') return 'exists';
    if (kind === 'done') throw new RunEndedElsewhere();
    if (kind === 'idempotent' && r.status === 'deduplicated') return 'ok';
    throw new ContextCorruptError(`unexpected ${r.status} for ${req.idempotencyKey}`);
  }

  private async publish<T extends EphemeralType>(type: T, payload: EphemeralPayloadOf<T>): Promise<void> {
    if (this.keeper.lost) return; // no ephemeral writes without a valid lease (§3.8)
    const env = {
      sessionId: this.sid,
      type,
      ts: this.now().toISOString(),
      traceId: this.traceId,
      fence: this.keeper.fence,
      payload,
    } as EphemeralEnvelope;
    try {
      await this.deps.publisher.publish(env);
    } catch (e) {
      this.log('publish failed', { type, error: (e as Error).message }); // best effort
    }
  }

  /** Hands call with retries on 5xx/network (200ms, 800ms) and one token refresh on 401 (§5.1). */
  private async callHands(
    req: ExecuteRequest,
    signal?: AbortSignal,
  ): Promise<{ status: 'ok'; response: ExecuteResponse } | { status: 'unavailable' } | { status: 'auth' }> {
    const delays = this.deps.handsRetryDelaysMs ?? EXECUTE_RETRY_DELAYS_MS;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const r = await this.deps.hands.execute(this.token, req, signal);
      if (r.status === 'ok') return r;
      if (r.status === 'auth') {
        if (refreshed) return { status: 'auth' };
        refreshed = true;
        const t = await this.deps.session.handsToken(this.sid, this.keeper.fence);
        if (t.status === 'stale') {
          this.keeper.markLost();
          throw new LeaseLostError();
        }
        if (t.status !== 'ok') return { status: 'auth' };
        this.token = t.token;
        attempt--; // a refresh is not a retry
        continue;
      }
      const d = delays[attempt];
      if (d === undefined || signal?.aborted) return { status: 'unavailable' };
      await this.sleep(d);
    }
  }

  private async acquireToken(): Promise<'ok' | 'lost' | 'inactive'> {
    const t = await this.deps.session.handsToken(this.sid, this.keeper.fence);
    if (t.status === 'stale') {
      this.keeper.markLost();
      return 'lost';
    }
    if (t.status !== 'ok') return 'inactive';
    this.token = t.token;
    return 'ok';
  }

  // ---------------------------------------------------------------------------------------------- start / resume

  async startRun(inputSeqs: readonly number[]): Promise<RunResultKind> {
    try {
      this.runId = newRunId();
      this.attempt = 1;
      this.inputSeq = Math.max(...inputSeqs);
      const tok = await this.acquireToken();
      if (tok !== 'ok') return tok;
      const profile = await this.profileSnapshot();
      const session = await this.deps.session.getSession(this.sid);
      const lastUser = ofType(this.events, 'user.message').find((e) => e.seq === this.inputSeq);
      const runs = ofType(this.events, 'agent.run_started');
      const lang = chooseLang({
        lastUserText: lastUser?.payload.text ?? '',
        profile,
        previousRunLang: runs[runs.length - 1]?.payload.lang,
        sessionLocale: session.locale,
      });
      const nowIso = this.now().toISOString();
      // compactor: before run_started, never during a run (D-52, §4.5)
      const cmp = compact(this.events, inputSeqs, { ...this.deps.compactOptions, nowIso });
      if (cmp !== null) {
        await this.emit(
          { type: 'agent.context_compacted', payload: cmp, idempotencyKey: compactIdempotencyKey(cmp.compactionId) },
          'idempotent',
        );
        this.log('context compacted', { estBefore: cmp.estBefore, estAfter: cmp.estAfter });
      }
      const payload: PayloadOf<'agent.run_started'> = {
        runId: this.runId,
        inputSeqs: [...inputSeqs],
        consumedUpToSeq: this.inputSeq,
        lang,
        today: nowIso.slice(0, 10),
        profile,
        model: this.deps.llm.model.id,
        promptVersion: PROMPT_VERSION,
        projectorVersion: PROJECTOR_VERSION,
        piVersion: PI_VERSION,
      };
      await this.emit(
        { type: 'agent.run_started', payload, idempotencyKey: runStartedIdempotencyKey(this.runId) },
        'strict',
      );
      await this.refresh();
      return await this.runLoop();
    } catch (e) {
      return this.handleFatal(e);
    }
  }

  async resumeRun(runId: string): Promise<RunResultKind> {
    try {
      this.runId = runId;
      this.inputSeq = this.started.payload.consumedUpToSeq;
      // step 0: ending reconciliation (no model call, no run_resumed)
      if (await this.reconcileEnding()) return 'done';

      const prior = 1 + ofType(this.events, 'agent.run_resumed').filter((e) => e.payload.runId === runId).length;
      this.attempt = prior + 1;
      if (this.attempt > this.limits.restartLimit) {
        this.attempt = prior; // the new attempt is not started; fill + template carry the last attempt number
        await this.fillDangling('interrupted');
        await this.writeTemplate('restart_limit', failed('RESTART_LIMIT', false));
        await this.writeEnding(failed('RESTART_LIMIT', false));
        return 'done';
      }
      const tok = await this.acquireToken();
      if (tok !== 'ok') return tok;
      await this.emit(
        {
          type: 'agent.run_resumed',
          payload: { runId, attempt: this.attempt },
          idempotencyKey: runResumedIdempotencyKey(runId, this.attempt),
        },
        'strict',
      );
      await this.refresh();
      await this.reissueOffers();

      let messages: AgentMessage[];
      try {
        messages = project(this.events, runId);
      } catch (e) {
        if (e instanceof ContextCorruptError) return await this.corrupt(e);
        throw e;
      }
      const tail = messages[messages.length - 1];
      if (tail?.role === 'assistant' && toolCallsOf(tail).length === 0 && this.tailIsOfRun()) {
        // the final reply was persisted; only run_completed is missing
        await this.writeEnding({ kind: 'completed', endReason: 'stop' });
        return 'done';
      }
      if (danglingToolCalls(messages).length > 0) await this.fillDangling('replay');
      return await this.runLoop();
    } catch (e) {
      return this.handleFatal(e);
    }
  }

  private tailIsOfRun(): boolean {
    const kept = keptAgentEvents(this.events, this.runId);
    return kept.length > 0;
  }

  private async handleFatal(e: unknown): Promise<RunResultKind> {
    if (e instanceof LeaseLostError) {
      this.log('lease lost');
      return 'lost';
    }
    if (e instanceof RunEndedElsewhere) return 'done';
    if (e instanceof ContextCorruptError) {
      try {
        return await this.corrupt(e);
      } catch (e2) {
        if (e2 instanceof LeaseLostError) return 'lost';
        if (e2 instanceof RunEndedElsewhere) return 'done';
        throw e2;
      }
    }
    throw e;
  }

  private async corrupt(e: Error): Promise<RunResultKind> {
    this.log('CONTEXT_CORRUPT', { reason: e.message }); // alert
    if (this.runId === '' || findRunStarted(this.events, this.runId) === undefined) return 'done';
    await this.writeTemplate('context_corrupt', failed('CONTEXT_CORRUPT', false));
    await this.writeEnding(failed('CONTEXT_CORRUPT', false));
    return 'done';
  }

  private async profileSnapshot(): Promise<ProfileSnapshot> {
    const r = await this.callHands({
      name: SYS_PROFILE_SNAPSHOT,
      input: {},
      toolCallId: 'sys_profile_snapshot',
      runId: this.runId,
      inputSeq: this.inputSeq,
    });
    if (r.status === 'ok' && r.response.ok) return r.response.data as unknown as ProfileSnapshot;
    // Not specified by A-02: run without a profile rather than failing the run (T09 report "新发现").
    this.log('profile snapshot unavailable', { status: r.status });
    return { frequentRoutes: [], ticketCount: 0 };
  }

  // ---------------------------------------------------------------------------------------------- recovery helpers

  /** §3.6 step 0. Returns true when it wrote the missing ending (the run is then done). */
  private async reconcileEnding(): Promise<boolean> {
    const runEvents = this.events.filter((e) => runIdOf(e) === this.runId);
    const replaced = runEvents.find(
      (e): e is EvOf<'agent.guard_violation'> => isType(e, 'agent.guard_violation') && e.payload.action === 'replaced',
    );
    const tplKey = templateMessageKey(this.runId, 'guard_fallback');
    const hasFallback = runEvents.some((e) => isType(e, 'agent.message') && e.payload.messageKey === tplKey);
    if (replaced !== undefined && !hasFallback) {
      this.attempt = replaced.payload.attempt;
      await this.writeTemplate('guard_fallback', { kind: 'completed', endReason: 'stop' });
      await this.writeEnding({ kind: 'completed', endReason: 'stop' });
      return true;
    }
    const kept = keptAgentEvents(this.events, this.runId);
    const last = kept[kept.length - 1];
    if (last !== undefined && isType(last, 'agent.message') && last.payload.role === 'assistant') {
      const p = last.payload;
      if (!p.hasToolCalls && p.meta !== undefined) {
        this.attempt = p.attempt;
        await this.writeEnding(p.meta.ending);
        return true;
      }
    }
    return false;
  }

  /** §3.6 step 4: re-emit quote.offered for successful offer_booking results that lack it. */
  private async reissueOffers(): Promise<void> {
    const offered = new Set(
      ofType(this.events, 'quote.offered')
        .filter((e) => e.payload.runId === this.runId)
        .map((e) => e.payload.toolCallId),
    );
    for (const e of keptAgentEvents(this.events, this.runId)) {
      if (!isType(e, 'agent.message') || e.payload.role !== 'toolResult') continue;
      const p = e.payload;
      if (p.toolName !== 'offer_booking' || p.isError || offered.has(p.toolCallId)) continue;
      await this.emitOffer(p.toolCallId, p.data);
    }
  }

  private async emitOffer(toolCallId: string, data: unknown): Promise<void> {
    const quoteId = (data as { quoteId?: unknown } | undefined)?.quoteId;
    if (typeof quoteId !== 'string') return;
    await this.emit(
      {
        type: 'quote.offered',
        payload: { runId: this.runId, quoteId, toolCallId },
        idempotencyKey: offerIdempotencyKey(this.runId, toolCallId),
      },
      'idempotent',
    );
  }

  /**
   * Fill rule (D-47, §3.6): every dangling toolCall gets a persisted result BEFORE continue(). 'replay' re-calls hands
   * with the original toolCallId and arguments (hands is idempotent); failure → the fixed INTERRUPTED text.
   * 'interrupted' writes INTERRUPTED directly (non-completed endings, I-6).
   */
  private async fillDangling(mode: 'replay' | 'interrupted'): Promise<void> {
    await this.refresh();
    let messages: AgentMessage[];
    try {
      messages = project(this.events, this.runId);
    } catch {
      return; // corrupt context: nothing sane to fill
    }
    const dangling = danglingToolCalls(messages);
    if (dangling.length === 0) return;
    const ts = Date.parse(this.started.ts);
    const used = this.countersFromLog();
    // ordinal of each dangling call within the run's tool budget
    const assistant = [...messages].reverse().find((m) => m.role === 'assistant') as AssistantMessage;
    const allCalls = toolCallsOf(assistant);
    const baseline = used.toolCalls - allCalls.length;
    for (const call of dangling) {
      let text = interruptedText(call);
      let isError = true;
      let data: unknown;
      let fill: 'replayed' | 'interrupted' = 'interrupted';
      if (mode === 'replay' && this.admissible(call, baseline + allCalls.findIndex((c) => c.id === call.id))) {
        const r = await this.callHands({
          name: call.name,
          input: call.arguments as Record<string, unknown>,
          toolCallId: call.id,
          runId: this.runId,
          inputSeq: this.inputSeq,
        });
        if (r.status === 'ok' && !(r.response.ok === false && r.response.error.code === 'IDEMPOTENCY_CONFLICT')) {
          const out = toolText(r.response);
          text = out.text;
          isError = !r.response.ok;
          data = r.response.ok ? r.response.data : r.response.error.data;
          fill = 'replayed';
        }
      }
      const msg = toolResultMessage(call.id, call.name, text, isError, ts, fill === 'replayed' ? { fill } : {});
      const res = await this.emitToolResult(msg, isError, data, fill);
      if (res === 'ok' && fill === 'replayed' && call.name === 'offer_booking' && !isError) {
        await this.emitOffer(call.id, data);
      }
    }
    await this.refresh();
  }

  private admissible(call: ToolCall, ordinal: number): boolean {
    if (rawArgsErrors(call.name, call.arguments).length > 0) return false;
    return ordinal < this.limits.maxToolCalls;
  }

  private async emitToolResult(
    msg: ToolResultMessage,
    isError: boolean,
    data: unknown,
    fill?: 'replayed' | 'interrupted',
  ): Promise<'ok' | 'exists'> {
    const payload: PayloadOf<'agent.message'> = {
      runId: this.runId,
      attempt: this.attempt,
      messageKey: toolResultMessageKey(this.runId, msg.toolCallId),
      role: 'toolResult',
      messageJson: JSON.stringify(msg),
      piVersion: PI_VERSION,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      isError,
      ...(data !== undefined ? { data } : {}),
      ...(fill !== undefined ? { fill } : {}),
    };
    return this.emit(
      {
        type: 'agent.message',
        payload,
        idempotencyKey: toolResultIdempotencyKey(this.runId, msg.toolCallId),
      },
      'toolResult',
    );
  }

  // ---------------------------------------------------------------------------------------------- endings

  private async writeTemplate(id: TemplateId, ending: Ending): Promise<void> {
    const lang = this.started.payload.lang;
    const text = TEMPLATE_TEXT[id][lang];
    // deterministic message (timestamp = run_started.ts) so concurrent writers dedup instead of conflicting
    const msg = templateAssistantMessage(this.deps.llm, text, Date.parse(this.started.ts));
    const messageKey = templateMessageKey(this.runId, id);
    await this.emit(
      {
        type: 'agent.message',
        payload: {
          runId: this.runId,
          attempt: this.attempt,
          messageKey,
          role: 'assistant',
          messageJson: JSON.stringify(msg),
          piVersion: PI_VERSION,
          hasToolCalls: false,
          viewText: text,
          meta: { template: id, ending },
        } as unknown as PayloadOf<'agent.message'>,
        idempotencyKey: messageIdempotencyKey(messageKey),
      },
      'idempotent',
    );
  }

  private async writeEnding(ending: Ending): Promise<void> {
    const key = runDoneIdempotencyKey(this.runId);
    await this.refresh(); // usage is summed from the persisted messages
    try {
      if (ending.kind === 'completed') {
        await this.emit(
          {
            type: 'agent.run_completed',
            payload: { runId: this.runId, endReason: ending.endReason, usage: this.usageSummary() },
            idempotencyKey: key,
          },
          'done',
        );
      } else {
        await this.emit(
          {
            type: 'agent.run_failed',
            payload: { runId: this.runId, code: ending.code, retryable: ending.retryable },
            idempotencyKey: key,
          },
          'done',
        );
      }
    } catch (e) {
      if (e instanceof RunEndedElsewhere) return;
      throw e;
    }
    this.log('run ended', { ending: ending.kind === 'completed' ? ending.endReason : ending.code });
  }

  /** From the log (persisted assistant messages of this run, all attempts) plus this process's unpersisted ones. */
  private usageSummary(): UsageSummary {
    const usages: Usage[] = [...this.unpersistedUsage];
    for (const e of ofType(this.events, 'agent.message')) {
      const p = e.payload;
      if (p.runId !== this.runId || p.role !== 'assistant' || (!p.hasToolCalls && p.meta !== undefined)) continue;
      const m = parseMessage(e);
      if (m.role === 'assistant') usages.push(m.usage);
    }
    const sum = (f: (u: Usage) => number): number => usages.reduce((a, u) => a + f(u), 0);
    const inputTokens = sum((u) => u.input);
    const outputTokens = sum((u) => u.output);
    const cacheReadTokens = sum((u) => u.cacheRead);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      reasoningTokens: sum((u) => u.reasoning ?? 0),
      requests: usages.length,
      costUsd:
        Math.round(
          ((inputTokens * COST_PER_M.input +
            cacheReadTokens * COST_PER_M.cacheRead +
            outputTokens * COST_PER_M.output) /
            1e6) *
            1e9,
        ) / 1e9,
    };
  }

  // ---------------------------------------------------------------------------------------------- the run loop

  /** Turns and tool calls are derived from the log (§3.4: a crash does not reset them, S-8). */
  private countersFromLog(): { turns: number; toolCalls: number; maxN: number; regenerates: number } {
    let turns = 0;
    let toolCalls = 0;
    for (const e of keptAgentEvents(this.events, this.runId)) {
      if (!isType(e, 'agent.message') || e.payload.role !== 'assistant') continue;
      if (!e.payload.hasToolCalls && e.payload.meta !== undefined) continue; // templates are not turns
      turns++;
      toolCalls += toolCallsOf(parseMessage(e)).length;
    }
    let maxN = -1;
    let regenerates = 0;
    for (const e of this.events) {
      if (runIdOf(e) !== this.runId) continue;
      if (isType(e, 'agent.message') && e.payload.n !== undefined) maxN = Math.max(maxN, e.payload.n);
      if (isType(e, 'agent.guard_violation')) {
        maxN = Math.max(maxN, e.payload.n);
        if (e.payload.action === 'regenerate') regenerates++;
      }
    }
    return { turns, toolCalls, maxN, regenerates };
  }

  private async runLoop(): Promise<RunResultKind> {
    const deadline = this.now().getTime() + this.limits.runTimeoutMs;
    const llmDelays = this.deps.llmRetryDelaysMs ?? [1000, 3000];
    let llmRetries = 0;
    let lengthRetries = 0;
    for (;;) {
      const o = await this.execOnce(deadline);
      this.log('pi run ended', { outcome: o.kind });
      switch (o.kind) {
        case 'lost':
          return 'lost';
        case 'ended_elsewhere':
          return 'done';
        case 'completed':
          await this.writeEnding({ kind: 'completed', endReason: 'stop' });
          return 'done';
        case 'regenerate':
          continue; // rebuild from the log (the guard notice is now projected)
        case 'replaced':
          await this.emit(
            {
              type: 'agent.guard_violation',
              payload: {
                runId: this.runId,
                attempt: this.attempt,
                n: o.n,
                messageKey: o.messageKey,
                guard: o.hit.guard,
                offending: o.hit.offending,
                action: 'replaced',
              },
              idempotencyKey: guardViolationIdempotencyKey(this.runId, o.n),
            },
            'strict',
          );
          await this.writeTemplate('guard_fallback', { kind: 'completed', endReason: 'stop' });
          await this.writeEnding({ kind: 'completed', endReason: 'stop' });
          return 'done';
        case 'turn_limit':
          await this.writeTemplate('turn_limit', { kind: 'completed', endReason: 'turn_limit' });
          await this.writeEnding({ kind: 'completed', endReason: 'turn_limit' });
          return 'done';
        case 'error':
        case 'request_timeout': {
          const d = llmDelays[llmRetries];
          if (d !== undefined) {
            llmRetries++;
            await this.sleep(d);
            continue;
          }
          return this.fail('llm_unavailable', failed('LLM_ERROR', true));
        }
        case 'length':
          if (lengthRetries < 1) {
            lengthRetries++;
            continue;
          }
          return this.fail('llm_unavailable', failed('LLM_LENGTH', true));
        case 'run_timeout':
          return this.fail('run_timeout', failed('RUN_TIMEOUT', true));
        case 'hands_auth':
          return this.fail('llm_unavailable', failed('HANDS_AUTH', true));
        case 'corrupt':
          await this.writeTemplate('context_corrupt', failed('CONTEXT_CORRUPT', false));
          await this.writeEnding(failed('CONTEXT_CORRUPT', false));
          return 'done';
      }
    }
  }

  /** Non-completed ending: fill → template → ending, one event at a time (§3.5). */
  private async fail(tpl: TemplateId, ending: Ending): Promise<RunResultKind> {
    await this.fillDangling('interrupted');
    await this.writeTemplate(tpl, ending);
    await this.writeEnding(ending);
    return 'done';
  }

  /** One pi run: rebuild the Agent from the log, continue(), persist as events arrive. */
  private async execOnce(deadline: number): Promise<Outcome> {
    await this.refresh();
    let messages: AgentMessage[];
    try {
      messages = project(this.events, this.runId);
    } catch (e) {
      if (e instanceof ContextCorruptError) {
        this.log('CONTEXT_CORRUPT', { reason: e.message });
        return { kind: 'corrupt' };
      }
      throw e;
    }
    const tail = messages[messages.length - 1];
    if (tail === undefined || (tail.role !== 'user' && tail.role !== 'toolResult')) {
      this.log('CONTEXT_CORRUPT', { reason: `tail ${tail?.role ?? 'none'}` });
      return { kind: 'corrupt' };
    }
    const counters = this.countersFromLog();
    let nextN = counters.maxN + 1;
    let turns = counters.turns;
    let toolCalls = counters.toolCalls;
    const regenerates = counters.regenerates;
    const sets = allowSets(this.events);
    const booked = hasBookingConfirmed(this.events, this.started.seq);

    const controller = new AbortController();
    let abortReason: string | undefined;
    let fatal: unknown;
    let outcome: Outcome | undefined;
    let turnLimitHit = false;
    const abort = (reason: string): void => {
      if (abortReason === undefined) abortReason = reason;
      controller.abort();
    };
    if (this.keeper.lost) return { kind: 'lost' };
    this.keeper.onLost(() => abort('lease_lost'));
    const runTimer = setTimeout(() => abort('run_timeout'), Math.max(0, deadline - this.now().getTime()));
    let reqTimer: ReturnType<typeof setTimeout> | undefined;
    const clearReq = (): void => {
      if (reqTimer !== undefined) clearTimeout(reqTimer);
      reqTimer = undefined;
    };

    let current: { n: number; key: string } | undefined;
    let pending: { calls: ToolCall[]; results: Map<string, ToolResultMessage> } | undefined;
    const ordinal = new Map<string, number>();
    const records = new Map<string, ToolRecord>();
    const started = new Set<string>();

    const guardHit = async (hit: GuardHit, cur: { n: number; key: string }): Promise<void> => {
      if (regenerates >= 1) {
        outcome = { kind: 'replaced', n: cur.n, messageKey: cur.key, hit };
        return;
      }
      await this.emit(
        {
          type: 'agent.guard_violation',
          payload: {
            runId: this.runId,
            attempt: this.attempt,
            n: cur.n,
            messageKey: cur.key,
            guard: hit.guard,
            offending: hit.offending,
            action: 'regenerate',
          },
          idempotencyKey: guardViolationIdempotencyKey(this.runId, cur.n),
        },
        'strict',
      );
      outcome = { kind: 'regenerate' };
    };

    const onAssistantEnd = async (m: AssistantMessage): Promise<void> => {
      clearReq();
      const cur = current ?? { n: nextN, key: assistantMessageKey(this.runId, this.attempt, nextN) };
      current = undefined;
      const calls = toolCallsOf(m);
      const text = m.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      const base = {
        runId: this.runId,
        attempt: this.attempt,
        n: cur.n,
        messageKey: cur.key,
        role: 'assistant' as const,
        messageJson: JSON.stringify(m),
        piVersion: PI_VERSION,
      };
      if (m.stopReason === 'stop' && calls.length === 0) {
        const hit = checkFinalReply(text, sets, booked);
        if (hit === undefined) {
          await this.emit(
            {
              type: 'agent.message',
              payload: { ...base, hasToolCalls: false, viewText: text },
              idempotencyKey: messageIdempotencyKey(cur.key),
            },
            'strict',
          );
          turns++;
          outcome = { kind: 'completed' };
          return;
        }
        this.unpersistedUsage.push(m.usage);
        await this.publish('agent.delta', { runId: this.runId, messageKey: cur.key, reset: true });
        await guardHit(hit, cur);
        return;
      }
      if (m.stopReason === 'toolUse' && calls.length > 0) {
        const tag = tagGuard(text);
        if (tag.length > 0) {
          // abort inside the listener: pi has not started the tools yet (V8)
          this.unpersistedUsage.push(m.usage);
          abort('guard');
          await guardHit({ guard: 'tag', offending: tag }, cur);
          return;
        }
        await this.emit(
          {
            type: 'agent.message',
            payload: { ...base, hasToolCalls: true, viewText: '', processText: text },
            idempotencyKey: messageIdempotencyKey(cur.key),
          },
          'strict',
        );
        turns++;
        calls.forEach((c, i) => ordinal.set(c.id, toolCalls + i));
        toolCalls += calls.length;
        pending = { calls, results: new Map() };
        return;
      }
      this.unpersistedUsage.push(m.usage);
      if (m.stopReason === 'length') {
        abort('length'); // pi would otherwise go on after failing the truncated calls
        outcome = { kind: 'length' };
      } else if (m.stopReason === 'error') {
        outcome = { kind: 'error' };
      }
      // aborted: the reason is already set by whoever aborted
    };

    const onToolResult = async (msg: ToolResultMessage): Promise<void> => {
      if (pending === undefined || !pending.calls.some((c) => c.id === msg.toolCallId)) return;
      pending.results.set(msg.toolCallId, msg);
      if (pending.results.size < pending.calls.length) return;
      const batch = pending;
      pending = undefined;
      // all results collected: persist in the toolCall's ORIGINAL order (D-44, O-2), offers right after
      for (const c of batch.calls) {
        const r = batch.results.get(c.id) as ToolResultMessage;
        const rec = records.get(c.id);
        const isError = rec?.isError ?? true; // blocked / failed validation / thrown → ours is true
        const res = await this.emitToolResult(r, isError, rec?.data);
        if (res === 'ok' && c.name === 'offer_booking' && !isError) await this.emitOffer(c.id, rec?.data);
      }
    };

    const onEvent = async (e: RuntimeEvent): Promise<void> => {
      if (abortReason !== undefined) return; // after an abort nothing pi produces is persisted
      try {
        switch (e.type) {
          case 'request_start':
            this.deps.onLlmPayload?.(e.payload);
            return;
          case 'assistant_start':
            // A-02 §3.5: the 60s request timer runs from the assistant message_start to its message_end; a request
            // that never starts streaming is bounded by the 120s run timer (M-23 ③: whichever fires first)
            clearReq();
            reqTimer = setTimeout(() => abort('request_timeout'), this.limits.requestTimeoutMs);
            current = { n: nextN, key: assistantMessageKey(this.runId, this.attempt, nextN) };
            nextN++;
            return;
          case 'text_delta':
            if (current !== undefined && e.delta !== '') {
              await this.publish('agent.delta', { runId: this.runId, messageKey: current.key, textDelta: e.delta });
            }
            return;
          case 'thinking_delta':
            if (current !== undefined) {
              for (const chunk of chunks(e.delta, 4096)) {
                await this.publish('agent.reasoning_delta', {
                  runId: this.runId,
                  messageKey: current.key,
                  textDelta: chunk,
                });
              }
            }
            return;
          case 'assistant_end':
            await onAssistantEnd(e.message);
            return;
          case 'tool_result':
            await onToolResult(e.message);
            return;
          case 'tool_allowed':
            started.add(e.toolCallId);
            await this.publish('agent.tool_status', {
              runId: this.runId,
              toolCallId: e.toolCallId,
              name: e.name,
              phase: 'start',
            });
            return;
          case 'tool_end':
            if (started.has(e.toolCallId)) {
              await this.publish('agent.tool_status', {
                runId: this.runId,
                toolCallId: e.toolCallId,
                name: e.name,
                phase: 'end',
                isError: records.get(e.toolCallId)?.isError ?? e.isError,
              });
            }
            return;
        }
      } catch (err) {
        fatal = err;
        abort('fatal');
      }
    };

    const executeTool = async (call: ToolCallRequest, signal: AbortSignal | undefined): Promise<ToolOutcome> => {
      const r = await this.callHands(
        { name: call.name, input: call.rawArgs, toolCallId: call.id, runId: this.runId, inputSeq: this.inputSeq },
        signal,
      ).catch((err: unknown) => {
        if (err instanceof LeaseLostError) abort('lease_lost');
        return { status: 'unavailable' as const };
      });
      if (r.status === 'auth') {
        records.set(call.id, { isError: true });
        abort('hands_auth');
        throw new Error(`${LLM_PREFIX_ERROR}HANDS_AUTH: tool authorization failed.`);
      }
      if (r.status === 'unavailable') {
        records.set(call.id, { isError: true });
        throw new Error(LLM_TEXT_HANDS_UNAVAILABLE); // pi turns it into the tool result text (V11)
      }
      const out = toolText(r.response);
      records.set(call.id, {
        isError: !r.response.ok,
        data: r.response.ok ? r.response.data : r.response.error.data,
      });
      return out;
    };

    try {
      const result = await runAgent({
        llm: this.deps.llm,
        systemPrompt: SYSTEM_PROMPT,
        tools: ALL_TOOLS,
        messages,
        sessionId: this.sid,
        executeTool,
        admitTool: (call) => {
          const o = ordinal.get(call.id);
          if (o !== undefined && o >= this.limits.maxToolCalls) {
            return `${LLM_PREFIX_BLOCKED}TOOL_BUDGET_EXCEEDED: this run already used its ${this.limits.maxToolCalls} tool calls. Answer the user with what you have.`;
          }
          return undefined;
        },
        shouldEndTurn: () => {
          if (abortReason !== undefined) return true;
          if (turns >= this.limits.maxTurns && outcome === undefined) {
            turnLimitHit = true;
            return true;
          }
          return false;
        },
        onEvent,
        signal: controller.signal,
      });
      if (outcome === undefined && abortReason === undefined && result.lastStopReason === 'error') {
        outcome = { kind: 'error' };
      }
    } catch (err) {
      if (abortReason === undefined) {
        fatal = err;
      }
    } finally {
      clearTimeout(runTimer);
      clearReq();
    }

    if (fatal !== undefined) {
      if (fatal instanceof LeaseLostError) return { kind: 'lost' };
      if (fatal instanceof RunEndedElsewhere) return { kind: 'ended_elsewhere' };
      if (fatal instanceof ContextCorruptError) {
        this.log('CONTEXT_CORRUPT', { reason: fatal.message });
        return { kind: 'corrupt' };
      }
      throw fatal;
    }
    switch (abortReason) {
      case 'lease_lost':
        return { kind: 'lost' };
      case 'request_timeout':
        return { kind: 'request_timeout' };
      case 'run_timeout':
        return { kind: 'run_timeout' };
      case 'hands_auth':
        return { kind: 'hands_auth' };
      case 'guard':
      case 'length':
        return outcome ?? { kind: 'error' };
      default:
        break;
    }
    if (outcome !== undefined) return outcome;
    if (turnLimitHit) return { kind: 'turn_limit' };
    return { kind: 'error' };
  }
}

// ------------------------------------------------------------------------------------------------ helpers

export function interruptedText(call: ToolCall): string {
  return `${LLM_PREFIX_INTERRUPTED}tool "${call.name}" (call ${call.id}) did not complete because the agent worker restarted. Its outcome is unknown. Do not tell the user it succeeded. If the result is still needed, call the tool again.`;
}

/** §5.1 table: what the LLM sees for a hands response. */
export function toolText(r: ExecuteResponse): ToolOutcome {
  if (r.ok) return { text: r.llmText, details: { ok: true, data: r.data } };
  return { text: `${LLM_PREFIX_ERROR}${r.error.code}: ${r.error.llmText}`, details: { ok: false, error: r.error } };
}

function chunks(s: string, size: number): string[] {
  if (s.length <= size) return s === '' ? [] : [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export { findOpenRun };
