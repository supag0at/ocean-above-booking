// projector (A-02 §4.1/§4.2, D-52, D-55): a deterministic, pure projection of the event log to pi messages.
// No trimming, no budget. Compaction is decided elsewhere (compactor.ts); here it is only *projected*.
import { escapeUserText } from '@fb/contracts/server';
import { isType, ofType, runIdOf, type Ev, type EvOf } from './events.ts';
import type { AgentMessage, AssistantMessage, ToolCall } from './llm/types.ts';
import { renderBookingConfirmed, renderBookingFailed, renderGuardNotice, renderRunContext } from './render.ts';

export const PROJECTOR_VERSION = 'proj-1';

export class ContextCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextCorruptError';
  }
}

export interface RunInfo {
  readonly runId: string;
  readonly started: EvOf<'agent.run_started'>;
  /** seq of the previous run's run_started (0 for the first run) */
  readonly prevStartSeq: number;
}

export function listRuns(events: readonly Ev[]): RunInfo[] {
  const out: RunInfo[] = [];
  let prev = 0;
  for (const s of ofType(events, 'agent.run_started')) {
    out.push({ runId: s.payload.runId, started: s, prevStartSeq: prev });
    prev = s.seq;
  }
  return out;
}

const ts = (e: Ev): number => Date.parse(e.ts);
const userMsg = (text: string, e: Ev): AgentMessage => ({ role: 'user', content: text, timestamp: ts(e) });

/**
 * The agent.message / guard_violation{regenerate} events of a run that survive the stale-attempt filter (§4.2 part 4,
 * fix I-10), in seq order:
 *   - assistant/system messages and guard events of attempt a are kept only if their seq is below the first
 *     run_resumed with attempt > a;
 *   - toolResults ignore attempt: kept iff the assistant holding their toolCall was kept.
 */
export function keptAgentEvents(events: readonly Ev[], runId: string): Ev[] {
  const resumes = ofType(events, 'agent.run_resumed').filter((e) => e.payload.runId === runId);
  const cutoff = (attempt: number): number => {
    const r = resumes.find((e) => e.payload.attempt > attempt);
    return r === undefined ? Number.POSITIVE_INFINITY : r.seq;
  };
  const keptCallIds = new Set<string>();
  const out: Ev[] = [];
  for (const e of events) {
    if (runIdOf(e) !== runId) continue;
    if (isType(e, 'agent.guard_violation')) {
      if (e.payload.action === 'regenerate' && e.seq < cutoff(e.payload.attempt)) out.push(e);
      continue;
    }
    if (!isType(e, 'agent.message')) continue;
    const p = e.payload;
    if (p.role === 'toolResult') {
      if (keptCallIds.has(p.toolCallId)) out.push(e);
      continue;
    }
    if (e.seq >= cutoff(p.attempt)) continue;
    if (p.role === 'assistant' && p.hasToolCalls) {
      for (const c of toolCallsOf(parseMessage(e))) keptCallIds.add(c.id);
    }
    out.push(e);
  }
  return out;
}

export function parseMessage(e: EvOf<'agent.message'>): AgentMessage {
  try {
    return JSON.parse(e.payload.messageJson) as AgentMessage;
  } catch {
    throw new ContextCorruptError(`messageJson of seq ${e.seq} is not JSON`);
  }
}

export function toolCallsOf(m: AgentMessage): ToolCall[] {
  if (m.role !== 'assistant') return [];
  return (m as AssistantMessage).content.filter((c): c is ToolCall => c.type === 'toolCall');
}

function segment(events: readonly Ev[], run: RunInfo, out: AgentMessage[]): void {
  // 1. booking events hung in front of this run (D-55)
  for (const e of events) {
    if (e.seq <= run.prevStartSeq || e.seq >= run.started.seq) continue;
    if (isType(e, 'booking.confirmed')) out.push(userMsg(renderBookingConfirmed(e.payload), e));
    else if (isType(e, 'booking.failed')) out.push(userMsg(renderBookingFailed(e.payload), e));
  }
  // 2. run_context
  out.push(userMsg(renderRunContext(run.started.payload), run.started));
  // 3. inputs
  const inputs = new Set(run.started.payload.inputSeqs);
  for (const e of ofType(events, 'user.message')) {
    if (inputs.has(e.seq)) out.push(userMsg(escapeUserText(e.payload.text), e));
  }
  // 4. agent messages
  for (const e of keptAgentEvents(events, run.runId)) {
    if (isType(e, 'agent.guard_violation')) out.push(userMsg(renderGuardNotice(e.payload), e));
    else if (isType(e, 'agent.message')) out.push(parseMessage(e));
  }
}

/** Index of the latest compaction (seq order) and the run it keeps first. */
export function latestCompaction(events: readonly Ev[]): EvOf<'agent.context_compacted'> | undefined {
  const all = ofType(events, 'agent.context_compacted');
  return all[all.length - 1];
}

export interface Projection {
  readonly messages: AgentMessage[];
  /** message index -> the run it belongs to (undefined for summary / moved system messages) */
  readonly runOf: readonly (string | undefined)[];
}

/**
 * project(events, currentRunId) -> AgentMessage[] (§4.2). `currentRunId` defaults to the last run in the log.
 * Throws ContextCorruptError when the projection violates the pairing rules (§4.2 "校验").
 */
export function project(events: readonly Ev[], currentRunId?: string): AgentMessage[] {
  return projectDetailed(events, currentRunId).messages;
}

export function projectDetailed(events: readonly Ev[], currentRunId?: string): Projection {
  const runs = listRuns(events);
  if (runs.length === 0) return { messages: [], runOf: [] };
  const curIdx = currentRunId === undefined ? runs.length - 1 : runs.findIndex((r) => r.runId === currentRunId);
  if (curIdx < 0) throw new ContextCorruptError(`run ${currentRunId ?? ''} not found`);
  const cur = runs[curIdx] as RunInfo;

  const cmp = latestCompaction(events.filter((e) => e.seq < cur.started.seq));
  let firstIdx = 0;
  const head: AgentMessage[] = [];
  const headRun: (string | undefined)[] = [];
  if (cmp !== undefined) {
    firstIdx = runs.findIndex((r) => r.runId === cmp.payload.boundaryRunId);
    if (firstIdx < 0 || firstIdx > curIdx) throw new ContextCorruptError('compaction boundary run not found');
    // system messages of folded runs keep the tool declarations: move them to the front (§4.2)
    for (const r of runs.slice(0, firstIdx)) {
      for (const e of keptAgentEvents(events, r.runId)) {
        if (isType(e, 'agent.message') && e.payload.role === 'system') {
          head.push(parseMessage(e));
          headRun.push(undefined);
        }
      }
    }
    head.push(userMsg(cmp.payload.summaryText, cmp));
    headRun.push(undefined);
  }

  const messages = [...head];
  const runOf = [...headRun];
  for (const r of runs.slice(firstIdx, curIdx + 1)) {
    const seg: AgentMessage[] = [];
    segment(events, r, seg);
    for (const m of seg) {
      messages.push(m);
      runOf.push(r.runId);
    }
  }
  validate(messages, runOf, cur.runId);
  return { messages, runOf };
}

function validate(messages: readonly AgentMessage[], runOf: readonly (string | undefined)[], currentRun: string): void {
  const seenIds = new Map<string, Set<string>>();
  // locate the last assistant of the current run: its dangling calls are allowed (filled by §3.6)
  let lastCurAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && runOf[i] === currentRun) lastCurAssistant = i;
  });
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as AgentMessage;
    if (m.role === 'toolResult') {
      // a toolResult is only legal right after its assistant (consumed below)
      throw new ContextCorruptError(`orphan toolResult at index ${i}`);
    }
    const calls = toolCallsOf(m);
    if (calls.length === 0) continue;
    const run = runOf[i] ?? '';
    const ids = seenIds.get(run) ?? new Set<string>();
    seenIds.set(run, ids);
    for (const c of calls) {
      if (ids.has(c.id)) throw new ContextCorruptError(`duplicate toolCallId ${c.id} in run ${run}`);
      ids.add(c.id);
    }
    let j = 0;
    for (; j < calls.length; j++) {
      const r = messages[i + 1 + j];
      if (r === undefined && i === lastCurAssistant) break; // dangling tail
      if (r?.role !== 'toolResult' || r.toolCallId !== (calls[j] as ToolCall).id) {
        throw new ContextCorruptError(`toolCall ${(calls[j] as ToolCall).id} at index ${i} not followed by its result`);
      }
    }
    i += j;
  }
}

/** Tool calls of the last assistant message (current run) that have no result yet, in original order. */
export function danglingToolCalls(messages: readonly AgentMessage[]): ToolCall[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AgentMessage;
    if (m.role !== 'assistant') continue;
    const calls = toolCallsOf(m);
    const have = new Set<string>();
    for (const r of messages.slice(i + 1)) if (r.role === 'toolResult') have.add(r.toolCallId);
    return calls.filter((c) => !have.has(c.id));
  }
  return [];
}
