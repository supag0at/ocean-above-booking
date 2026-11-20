// compactor (A-02 §4.5, D-52, D-56, D-57): an independent, pure component. Runs only before a NEW run starts.
import { COMPACT_HIGH, COMPACT_LOW, COMPACT_MAX_QUOTES } from '@fb/contracts/flight';
import { compactionId, type PayloadOf } from '@fb/contracts/server';
import { ALL_TOOLS } from '@fb/contracts/tools';
import { isType, lastSeq, ofType, type Ev, type EvOf } from './events.ts';
import type { AgentMessage } from './llm/types.ts';
import { latestCompaction, listRuns, projectDetailed } from './projector.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { cmpCodePoint, routeOf } from './render.ts';

export const SUMMARY_VERSION = 1;
const RUN_CONTEXT_EST = 100;
const MAX_TICKETS = 20;
const MAX_CITIES = 30;
const SYNTH_RUN = 'run_00000000000000000000000000'; // placeholder id for the hypothetical new run (never written)

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
/** CJK chars count 1 each, other chars 1 per 3 (§4.5 step 1). */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const c of text) {
    if (CJK.test(c)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}

export function messageText(m: AgentMessage): string {
  switch (m.role) {
    case 'user':
      return typeof m.content === 'string'
        ? m.content
        : m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    case 'system':
      return typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('');
    case 'toolResult':
      return m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    case 'assistant':
      return m.content
        .map((c) =>
          c.type === 'text' ? c.text : c.type === 'thinking' ? c.thinking : `${c.name}${JSON.stringify(c.arguments)}`,
        )
        .join('');
    default:
      return '';
  }
}

/** System prompt + tool declarations (not in the projection under V3 outcome ②, but sent every time). */
export const FIXED_TOKENS = estimateTokens(
  SYSTEM_PROMPT + JSON.stringify(ALL_TOOLS.map((t) => ({ n: t.name, d: t.description, p: t.parameters }))),
);

function synthRunStarted(events: readonly Ev[], pendingInputs: readonly number[], ts: string): Ev {
  const seq = lastSeq(events) + 1;
  const base = events[0] as Ev;
  return {
    id: '00000000-0000-0000-0000-000000000000',
    sessionId: base.sessionId,
    seq,
    type: 'agent.run_started',
    actor: 'agent',
    ts,
    traceId: 'synthetic',
    idempotencyKey: 'synthetic',
    schemaVersion: 1,
    payload: {
      runId: SYNTH_RUN,
      inputSeqs: [...pendingInputs],
      consumedUpToSeq: Math.max(...pendingInputs),
      lang: 'en',
      today: ts.slice(0, 10),
      profile: { frequentRoutes: [], ticketCount: 0 },
      model: 'x',
      promptVersion: 'x',
      projectorVersion: 'x',
      piVersion: 'x',
    },
  } as EvOf<'agent.run_started'>;
}

interface Sized {
  readonly total: number;
  readonly perRun: Map<string, number>;
  readonly runOrder: string[];
}

function sizeOf(events: readonly Ev[], currentRunId: string): Sized {
  const p = projectDetailed(events, currentRunId);
  const perRun = new Map<string, number>();
  const runOrder: string[] = [];
  let total = FIXED_TOKENS;
  p.messages.forEach((m, i) => {
    const run = p.runOf[i];
    // the hypothetical run_context is estimated at a flat 100 tokens
    const isSynthCtx = run === SYNTH_RUN && m.role === 'user' && messageText(m).startsWith('<run_context>');
    const t = isSynthCtx ? RUN_CONTEXT_EST : estimateTokens(messageText(m));
    total += t;
    if (run !== undefined) {
      if (!perRun.has(run)) runOrder.push(run);
      perRun.set(run, (perRun.get(run) ?? 0) + t);
    }
  });
  return { total, perRun, runOrder };
}

export interface CompactOptions {
  readonly high?: number;
  readonly low?: number;
  /** ts used for the hypothetical run (only influences nothing but its date line) */
  readonly nowIso?: string;
}

/** compact(events, pendingInputs) -> payload of agent.context_compacted, or null (§4.5). Pure. */
export function compact(
  events: readonly Ev[],
  pendingInputs: readonly number[],
  opts: CompactOptions = {},
): PayloadOf<'agent.context_compacted'> | null {
  const high = opts.high ?? COMPACT_HIGH;
  const low = opts.low ?? COMPACT_LOW;
  const runs = listRuns(events);
  if (runs.length === 0 || pendingInputs.length === 0) return null; // a session that never ran cannot compact
  const withSynth = [...events, synthRunStarted(events, pendingInputs, opts.nowIso ?? '2000-01-01T00:00:00.000Z')];
  const before = sizeOf(withSynth, SYNTH_RUN);
  if (before.total <= high) return null;

  const finished = before.runOrder.filter((r) => r !== SYNTH_RUN);
  const newTok = before.perRun.get(SYNTH_RUN) ?? 0;
  let keepFrom = finished.length - 1; // keep at least the latest finished run
  let acc = before.perRun.get(finished[keepFrom] ?? '') ?? 0;
  while (keepFrom > 0) {
    const t = before.perRun.get(finished[keepFrom - 1] as string) ?? 0;
    if (FIXED_TOKENS + newTok + acc + t > low) break;
    acc += t;
    keepFrom--;
  }
  const boundaryRunId = finished[keepFrom];
  if (boundaryRunId === undefined) return null;
  const prev = latestCompaction(events);
  const firstRun = runs[0]?.runId;
  // nothing to fold: boundary already is the current boundary (or the very first run)
  if (boundaryRunId === (prev?.payload.boundaryRunId ?? firstRun)) return null;

  const summaryText = summarize(events, boundaryRunId);
  const cmpId = compactionId(boundaryRunId);
  const payload: PayloadOf<'agent.context_compacted'> = {
    compactionId: cmpId,
    boundaryRunId,
    summaryText,
    summaryVersion: SUMMARY_VERSION,
    estBefore: before.total,
    estAfter: 0,
  };
  const synth = withSynth[withSynth.length - 1] as Ev;
  const cmpEv = {
    ...synth,
    seq: synth.seq,
    type: 'agent.context_compacted',
    payload,
  } as unknown as Ev;
  const after = sizeOf([...events, cmpEv, { ...synth, seq: synth.seq + 1 } as Ev], SYNTH_RUN);
  return { ...payload, estAfter: after.total };
}

/**
 * Deterministic, number-free summary of every run before the boundary (§4.5 step 5). Built from the full log, never
 * from an older summary, so repeated compactions are reproducible.
 */
export function summarize(events: readonly Ev[], boundaryRunId: string): string {
  const runs = listRuns(events);
  const idx = runs.findIndex((r) => r.runId === boundaryRunId);
  const folded = runs.slice(0, Math.max(0, idx));
  const foldedIds = new Set(folded.map((r) => r.runId));
  const boundary = runs[idx];
  const foldedUntil = boundary?.prevStartSeq ?? 0; // bookings hung before the boundary run stay in its segment

  const quotes: string[] = [];
  const cities = new Set<string>();
  for (const e of ofType(events, 'agent.message')) {
    const p = e.payload;
    if (p.role !== 'toolResult' || !foldedIds.has(p.runId) || p.toolName !== 'quote_route' || p.isError) continue;
    const q = p.data as {
      quoteId?: string;
      from?: string;
      to?: string;
      legs?: { from: string; to: string }[];
      transferCities?: string[];
    };
    if (typeof q?.quoteId !== 'string' || typeof q.from !== 'string' || typeof q.to !== 'string') continue;
    const transfers = q.transferCities ?? [];
    const tail =
      transfers.length === 0
        ? '(direct)'
        : `(${transfers.length} transfer${transfers.length === 1 ? '' : 's'} at ${transfers.join(', ')})`;
    quotes.push(`quote: ${q.quoteId} ${routeOf(q.legs ?? [], q.from, q.to)} ${tail}`);
    for (const c of [q.from, q.to, ...transfers]) cities.add(c);
  }
  const tickets: string[] = [];
  for (const e of ofType(events, 'booking.confirmed')) {
    if (e.seq > foldedUntil) continue;
    const s = e.payload.summary;
    tickets.push(`ticket: ${e.payload.ticketNo} ${s.from} -> ${s.to}`);
    for (const c of [s.from, s.to, ...s.transferCities]) cities.add(c);
  }
  const cityList = [...cities].sort(cmpCodePoint).slice(0, MAX_CITIES);
  return [
    '<system_event type="context_compacted">',
    `covered_runs: ${folded.length}`,
    ...quotes.slice(-COMPACT_MAX_QUOTES),
    ...tickets.slice(-MAX_TICKETS),
    ...(cityList.length > 0 ? [`cities: ${cityList.join(', ')}`] : []),
    'note: earlier conversation was offloaded. Use list_my_tickets for tickets; quotes can still be offered by quoteId.',
    '</system_event>',
  ].join('\n');
}

export function isCompaction(e: Ev): e is EvOf<'agent.context_compacted'> {
  return isType(e, 'agent.context_compacted');
}
