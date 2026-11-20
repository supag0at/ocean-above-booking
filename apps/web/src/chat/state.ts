// Chat state: a seq-ordered list of PUBLIC events (A-01 §4.5) plus in-memory ephemeral content per run.
// Everything the UI shows is derived from this by buildTimeline(); no number is ever parsed out of text (H-01).
import type { ErrorCode, PublicEphemeral, PublicEvent, SessionStatus } from '@fb/contracts/web';

export interface LiveRun {
  reasoning: Array<{ messageKey: string; text: string }>;
  deltas: Array<{ messageKey: string; text: string }>;
  tools: Array<{ toolCallId: string; name: string; phase: 'start' | 'end'; isError: boolean }>;
}

export interface ChatState {
  /** Sorted by seq, unique by seq. */
  events: PublicEvent[];
  /** Ephemeral content of runs that are still running. Memory only; dropped when the run finishes (§9.4.1 #3). */
  live: Record<string, LiveRun>;
  /** Runs known to be finished: late ephemeral events for them are ignored. */
  finished: Record<string, true>;
  status: SessionStatus | null;
}

export const initialChatState: ChatState = { events: [], live: {}, finished: {}, status: null };

export type ChatAction =
  /** `live` = came from the SSE stream (as opposed to REST history), which also drives the display status. */
  | { type: 'events'; events: PublicEvent[]; live?: boolean }
  | { type: 'eph'; eph: PublicEphemeral }
  | { type: 'status'; status: SessionStatus }
  | { type: 'reset' };

export function maxSeq(state: ChatState): number {
  return state.events.length ? state.events[state.events.length - 1]!.seq : 0;
}

function runIdOf(e: PublicEvent): string | null {
  switch (e.type) {
    case 'agent.message':
    case 'agent.run_started':
    case 'agent.run_resumed':
    case 'agent.run_completed':
    case 'agent.run_failed':
    case 'agent.guard_violation':
      return e.payload.runId;
    default:
      return null;
  }
}

/** Does this persisted event end the run's live phase? (§9.4.1 #2) */
function endsRun(e: PublicEvent): string | null {
  if (e.type === 'agent.run_completed' || e.type === 'agent.run_failed') return e.payload.runId;
  if (e.type === 'agent.message' && 'kind' in e.payload && e.payload.kind === 'reply') return e.payload.runId;
  return null;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'status':
      return { ...state, status: action.status };
    case 'events': {
      const bySeq = new Map(state.events.map((e) => [e.seq, e]));
      const added: PublicEvent[] = [];
      for (const e of action.events) {
        if (!bySeq.has(e.seq)) {
          bySeq.set(e.seq, e);
          added.push(e);
        }
      }
      if (added.length === 0) return state;
      const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      const live = { ...state.live };
      const finished = { ...state.finished };
      let status = state.status;
      for (const e of added) {
        const ended = endsRun(e);
        if (ended) {
          delete live[ended];
          finished[ended] = true;
          if (action.live) status = 'idle';
        } else if (action.live && e.type === 'agent.run_started') {
          status = 'running';
        }
        // A persisted message supersedes the streamed text of its messageKey (§9.5).
        if (e.type === 'agent.message') {
          const run = live[e.payload.runId];
          if (run) {
            live[e.payload.runId] = {
              ...run,
              reasoning: run.reasoning.filter((r) => r.messageKey !== e.payload.messageKey),
              deltas: run.deltas.filter((d) => d.messageKey !== e.payload.messageKey),
            };
          }
        }
      }
      return { ...state, events, live, finished, status };
    }
    case 'eph': {
      const { eph } = action;
      const runId = eph.payload.runId;
      if (state.finished[runId]) return state;
      const prev: LiveRun = state.live[runId] ?? { reasoning: [], deltas: [], tools: [] };
      let next: LiveRun;
      if (eph.type === 'agent.delta') {
        const p = eph.payload;
        if ('reset' in p) {
          // Guard retraction: clear this messageKey's streamed text at once (§9.5).
          next = { ...prev, deltas: prev.deltas.filter((d) => d.messageKey !== p.messageKey) };
        } else {
          next = { ...prev, deltas: appendText(prev.deltas, p.messageKey, p.textDelta) };
        }
      } else if (eph.type === 'agent.reasoning_delta') {
        next = { ...prev, reasoning: appendText(prev.reasoning, eph.payload.messageKey, eph.payload.textDelta) };
      } else {
        const p = eph.payload;
        const rest = prev.tools.filter((t) => t.toolCallId !== p.toolCallId);
        next = {
          ...prev,
          tools: [...rest, { toolCallId: p.toolCallId, name: p.name, phase: p.phase, isError: p.isError === true }],
        };
      }
      return { ...state, live: { ...state.live, [runId]: next } };
    }
  }
}

function appendText(list: Array<{ messageKey: string; text: string }>, key: string, delta: string) {
  const i = list.findIndex((x) => x.messageKey === key);
  if (i < 0) return [...list, { messageKey: key, text: delta }];
  return list.map((x, j) => (j === i ? { ...x, text: x.text + delta } : x));
}

// ---------------------------------------------------------------------------------------------------------------
// Timeline

export type ProcessStep =
  { kind: 'text'; key: string; text: string } | { kind: 'tool'; key: string; toolName: string; isError: boolean };

export type TimelineItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'reply'; key: string; text: string }
  | {
      kind: 'run';
      key: string;
      runId: string;
      steps: ProcessStep[];
      /** Number of persisted kind:'process' messages (N in the collapsed header). */
      processCount: number;
      finished: boolean;
      live: LiveRun | null;
    }
  | {
      kind: 'quote';
      key: string;
      quoteId: string;
      booked: { ticketId: string; ticketNo: string } | null;
      failedCode: ErrorCode | null;
    }
  | { kind: 'ticket'; key: string; ticketId: string; ticketNo: string; quoteId: string };

export interface Timeline {
  items: TimelineItem[];
  /** Show the typing animation: running, and no run is already showing live content (§9.4 status frame). */
  typing: boolean;
}

type RunItem = Extract<TimelineItem, { kind: 'run' }>;
type QuoteItem = Extract<TimelineItem, { kind: 'quote' }>;

export function buildTimeline(state: ChatState): Timeline {
  const items: TimelineItem[] = [];
  const runs = new Map<string, RunItem>();
  const quotes = new Map<string, QuoteItem>();

  const ensureRun = (runId: string): RunItem => {
    let r = runs.get(runId);
    if (!r) {
      r = { kind: 'run', key: `run:${runId}`, runId, steps: [], processCount: 0, finished: false, live: null };
      runs.set(runId, r);
      items.push(r);
    }
    return r;
  };

  for (const e of state.events) {
    const runId = runIdOf(e);
    const run = runId ? ensureRun(runId) : null;
    if (run && endsRun(e)) run.finished = true;
    switch (e.type) {
      case 'user.message':
        items.push({ kind: 'user', key: `u:${e.seq}`, text: e.payload.text });
        break;
      case 'agent.message': {
        const p = e.payload;
        if ('toolCallId' in p) {
          run!.steps.push({ kind: 'tool', key: `t:${p.toolCallId}`, toolName: p.toolName, isError: p.isError });
        } else if (p.kind === 'process') {
          run!.processCount += 1;
          run!.steps.push({ kind: 'text', key: `p:${p.messageKey}`, text: p.processText });
        } else {
          items.push({ kind: 'reply', key: `r:${e.seq}`, text: p.text });
        }
        break;
      }
      case 'quote.offered': {
        const q: QuoteItem = {
          kind: 'quote',
          key: `q:${e.payload.quoteId}`,
          quoteId: e.payload.quoteId,
          booked: null,
          failedCode: null,
        };
        quotes.set(q.quoteId, q);
        items.push(q);
        break;
      }
      case 'booking.confirmed': {
        const q = quotes.get(e.payload.quoteId);
        if (q) {
          q.booked = { ticketId: e.payload.ticketId, ticketNo: e.payload.ticketNo };
          q.failedCode = null;
        }
        items.push({
          kind: 'ticket',
          key: `tk:${e.payload.ticketId}`,
          ticketId: e.payload.ticketId,
          ticketNo: e.payload.ticketNo,
          quoteId: e.payload.quoteId,
        });
        break;
      }
      case 'booking.failed': {
        const q = quotes.get(e.payload.quoteId);
        if (q && !q.booked) q.failedCode = e.payload.code;
        break;
      }
      default:
        break; // run_started / resumed / completed / failed / guard_violation / hidden: nothing to render by themselves
    }
  }

  let liveContent = false;
  for (const run of runs.values()) {
    if (state.finished[run.runId]) run.finished = true;
    if (!run.finished) {
      run.live = state.live[run.runId] ?? null;
      if (
        run.steps.length > 0 ||
        (run.live && (run.live.deltas.length || run.live.reasoning.length || run.live.tools.length))
      ) {
        liveContent = true;
      }
    }
  }
  return { items, typing: (state.status === 'running' || state.status === 'queued') && !liveContent };
}

/** True when a run item has anything to show (a finished run with zero process messages is hidden, §9.4.1 #4). */
export function runVisible(run: RunItem): boolean {
  if (run.finished) return run.processCount > 0;
  const l = run.live;
  return run.steps.length > 0 || (l !== null && (l.deltas.length > 0 || l.reasoning.length > 0 || l.tools.length > 0));
}
