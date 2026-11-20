// Agent assertions. They read the internal event log only, plus the two exceptions in the case README
// (tickets_unchanged count, no_prompt_leak against the harness prompt text).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatKm, formatUsdCents } from '../../packages/contracts/src/web/format.ts';
import { SYSTEM_PROMPT } from '../../services/harness/src/prompt.ts';
import { allowSets, bookingClaimGuard, numberGuard, tagGuard } from '../../services/harness/src/guards.ts';
import type { Ev } from '../../services/harness/src/events.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface LogEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface SessionLog {
  index: number;
  id: string;
  events: LogEvent[];
}

export interface TurnMark {
  index: number;
  kind: 'user' | 'new_session' | 'click' | 'other';
  session: number;
  seq?: number;
}

export interface AssertContext {
  sessions: SessionLog[];
  turns: TurnMark[];
  placeholders: Record<string, string>;
  ticketsBefore: number;
  ticketsAfter: number;
  hasSimulateClick: boolean;
  category: string;
  expectsRunFailed: boolean;
  cities: readonly string[];
}

export interface AssertOutcome {
  pass: boolean;
  failures: string[];
  reports: string[];
  modelCalls: number;
}

const oracleCache = new Map<string, Record<string, unknown>>();

function oracleRoute(from: string, to: string): Record<string, unknown> {
  const key = `${from}\n${to}`;
  const hit = oracleCache.get(key);
  if (hit) return hit;
  const r = spawnSync('python', [join(here, 'oracle_side.py'), 'route'], {
    input: JSON.stringify({ from, to }),
    encoding: 'utf8',
  });
  const parsed =
    r.status === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>) : { ok: false, error: 'oracle failed' };
  oracleCache.set(key, parsed);
  return parsed;
}

function nfc(s: string): string {
  return s.normalize('NFC');
}

function eventsOf(ctx: AssertContext): LogEvent[] {
  return ctx.sessions.flatMap((s) => s.events.map((e) => ({ ...e, payload: { ...e.payload, __session: s.index } })));
}

function runIdsForTurn(ctx: AssertContext, turn: number): Set<string> {
  const mark = ctx.turns.find((t) => t.index === turn && t.kind === 'user');
  const ids = new Set<string>();
  if (!mark || mark.seq === undefined) return ids;
  for (const s of ctx.sessions) {
    if (s.index !== mark.session) continue;
    for (const e of s.events) {
      if (e.type !== 'agent.run_started') continue;
      const seqs = e.payload.inputSeqs;
      if (Array.isArray(seqs) && seqs.includes(mark.seq)) ids.add(String(e.payload.runId));
    }
  }
  return ids;
}

function scopeEvents(ctx: AssertContext, spec: Record<string, unknown>): LogEvent[] {
  const all = eventsOf(ctx);
  if (typeof spec.session === 'number') {
    return all.filter((e) => e.payload.__session === spec.session - 1);
  }
  if (typeof spec.turn === 'number') {
    const ids = runIdsForTurn(ctx, spec.turn);
    const owned = all.filter((e) => ids.has(String(e.payload.runId ?? '')));
    const seqs = owned.map((e) => e.seq);
    if (seqs.length === 0) return owned;
    const lo = Math.min(...seqs);
    const hi = Math.max(...seqs);
    const extra = all.filter(
      (e) =>
        (e.type === 'quote.offered' || e.type === 'booking.confirmed' || e.type === 'booking.failed') &&
        e.seq >= lo &&
        e.seq <= hi &&
        !owned.includes(e),
    );
    return [...owned, ...extra].sort((a, b) => a.seq - b.seq);
  }
  return all;
}

interface ToolCallRec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  runId: string;
  seq: number;
  session: number;
}

interface ToolResultRec {
  toolCallId: string;
  name: string;
  isError: boolean;
  data: unknown;
  text: string;
  runId: string;
  seq: number;
  session: number;
}

function asRec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseTools(events: LogEvent[]): { calls: ToolCallRec[]; results: ToolResultRec[] } {
  const calls: ToolCallRec[] = [];
  const results: ToolResultRec[] = [];
  for (const e of events) {
    if (e.type !== 'agent.message') continue;
    const p = e.payload;
    const raw = typeof p.messageJson === 'string' ? p.messageJson : '';
    let msg: Record<string, unknown> | undefined;
    try {
      msg = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    } catch {
      msg = undefined;
    }
    const session = Number(p.__session ?? 0);
    const runId = String(p.runId ?? '');
    if (p.role === 'assistant' && Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        const c = asRec(part);
        if (!c || c.type !== 'toolCall') continue;
        calls.push({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          args: asRec(c.arguments) ?? {},
          runId,
          seq: e.seq,
          session,
        });
      }
    }
    if (p.role === 'toolResult') {
      let text = '';
      if (Array.isArray(msg?.content)) {
        text = msg.content
          .map((part) => {
            const c = asRec(part);
            return c && c.type === 'text' && typeof c.text === 'string' ? c.text : '';
          })
          .join('');
      }
      results.push({
        toolCallId: String(p.toolCallId ?? ''),
        name: String(p.toolName ?? ''),
        isError: p.isError === true,
        data: p.data,
        text,
        runId,
        seq: e.seq,
        session,
      });
    }
  }
  return { calls, results };
}

function argsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const a = actual[k];
    if (typeof v === 'string' && typeof a === 'string') {
      if (nfc(v) !== nfc(a)) return false;
    } else if (JSON.stringify(v) !== JSON.stringify(a)) return false;
  }
  return true;
}

function fill(s: string, ph: Record<string, string>): string {
  return s.replace(/\$\{([^}]+)\}/g, (all, key: string) => (key in ph ? ph[key]! : all));
}

function fillValue(v: unknown, ph: Record<string, string>): unknown {
  if (typeof v === 'string') return fill(v, ph);
  if (Array.isArray(v)) return v.map((x) => fillValue(x, ph));
  if (asRec(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = fillValue(x, ph);
    return out;
  }
  return v;
}

function finalReplies(events: LogEvent[]): { text: string; seq: number; runId: string; template?: string }[] {
  const out: { text: string; seq: number; runId: string; template?: string }[] = [];
  for (const e of events) {
    if (e.type !== 'agent.message') continue;
    const p = e.payload;
    if (p.role !== 'assistant' || p.hasToolCalls === true) continue;
    const meta = asRec(p.meta);
    const template = meta && typeof meta.template === 'string' ? meta.template : undefined;
    out.push({ text: String(p.viewText ?? ''), seq: e.seq, runId: String(p.runId ?? ''), template });
  }
  return out;
}

function replyLang(text: string, cities: readonly string[]): 'zh' | 'en' | 'mid' | 'empty' {
  let t = nfc(text);
  const names = [...cities].sort((a, b) => b.length - a.length);
  for (const name of names) t = t.split(name).join('');
  let cjk = 0;
  let denom = 0;
  for (const ch of t) {
    if (/\s/u.test(ch)) continue;
    denom++;
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) cjk++;
  }
  if (denom === 0) return 'empty';
  const ratio = cjk / denom;
  if (ratio >= 0.2) return 'zh';
  if (ratio < 0.05) return 'en';
  return 'mid';
}

function subset(got: unknown, exp: unknown): boolean {
  if (exp === null || typeof exp !== 'object') return Object.is(got, exp);
  if (Array.isArray(exp)) {
    if (!Array.isArray(got) || got.length !== exp.length) return false;
    return exp.every((v, i) => subset(got[i], v));
  }
  const g = asRec(got);
  if (!g) return false;
  return Object.entries(exp as Record<string, unknown>).every(([k, v]) => subset(g[k], v));
}

function quoteDataMatches(data: unknown, oracle: Record<string, unknown>): string | undefined {
  const d = asRec(data);
  if (!d || oracle.ok !== true) return 'oracle or data not ok';
  const legs = Array.isArray(d.legs) ? d.legs : [];
  const path = legs.map((leg) => {
    const l = asRec(leg);
    return l ? `${l.from}>${l.to}` : '';
  });
  const oLegs = Array.isArray(oracle.legs) ? oracle.legs : [];
  const oPath = oLegs.map((leg) => {
    const l = asRec(leg);
    return l ? `${l.from}>${l.to}` : '';
  });
  if (path.join('|') !== oPath.join('|')) return `path impl=${path.join('|')} oracle=${oPath.join('|')}`;
  const km = Number(d.totalDistanceKm);
  const oKm = Number(oracle.totalDistanceKm);
  if (!(Math.abs(km - oKm) < 1e-6)) return `totalDistanceKm impl=${km} oracle=${oKm}`;
  if (d.priceCents !== oracle.priceCents)
    return `priceCents impl=${String(d.priceCents)} oracle=${String(oracle.priceCents)}`;
  const display = asRec(d.display);
  const oDisplay = {
    legs: oLegs.map((leg) => formatKm(Number(asRec(leg)?.distanceKm), 'en')),
    totalDistanceKm: formatKm(oKm, 'en'),
    priceUsd: formatUsdCents(Number(oracle.priceCents), 'en'),
  };
  if (!display || JSON.stringify(display.legs) !== JSON.stringify(oDisplay.legs)) return 'display.legs';
  if (display.totalDistanceKm !== oDisplay.totalDistanceKm) return 'display.totalDistanceKm';
  if (display.priceUsd !== oDisplay.priceUsd) return 'display.priceUsd';
  for (let i = 0; i < legs.length; i++) {
    const gotKm = Number(asRec(legs[i])?.distanceKm);
    const expKm = Number(asRec(oLegs[i])?.distanceKm);
    if (!(Math.abs(gotKm - expKm) < 1e-6)) return `leg ${i} distance`;
  }
  return undefined;
}

function collapse(s: string): string {
  return nfc(s).replace(/\s+/gu, ' ').trim();
}

function leaks(reply: string, prompt: string, n: number): boolean {
  const a = collapse(reply);
  const b = collapse(prompt);
  if (a.length < n || b.length < n) return false;
  const grams = new Set<string>();
  for (let i = 0; i + n <= b.length; i++) grams.add(b.slice(i, i + n));
  for (let i = 0; i + n <= a.length; i++) if (grams.has(a.slice(i, i + n))) return true;
  return false;
}

function modelCalls(events: LogEvent[]): number {
  const byRun = new Map<string, { requests: number; assistants: number }>();
  const slot = (id: string) => {
    let s = byRun.get(id);
    if (!s) {
      s = { requests: 0, assistants: 0 };
      byRun.set(id, s);
    }
    return s;
  };
  for (const e of events) {
    if (e.type === 'agent.run_completed') {
      const usage = asRec(e.payload.usage);
      const n = usage && typeof usage.requests === 'number' ? usage.requests : 0;
      slot(String(e.payload.runId)).requests = n;
    }
    if (e.type === 'agent.message' && e.payload.role === 'assistant' && !asRec(e.payload.meta)?.template) {
      slot(String(e.payload.runId)).assistants += 1;
    }
  }
  let total = 0;
  for (const s of byRun.values()) total += Math.max(s.requests, s.assistants);
  return total;
}

function checkFinal(
  ctx: AssertContext,
  events: LogEvent[],
  spec: Record<string, unknown>,
  failures: string[],
  reports: string[],
): void {
  const soft = spec.soft === true;
  const problems: string[] = [];
  const replies = finalReplies(events);
  const targets = spec.each_turn === true ? repliesOfEachTurn(ctx, spec) : replies.slice(-1);
  if (targets.length === 0) problems.push('no final reply');
  for (const reply of targets) {
    const text = nfc(reply.text);
    if (typeof spec.lang === 'string') {
      const got = replyLang(reply.text, ctx.cities);
      if (got !== spec.lang) problems.push(`lang impl=${got} case=${String(spec.lang)}`);
    }
    if (Array.isArray(spec.contains_all)) {
      for (const s of spec.contains_all) if (!text.includes(nfc(String(s)))) problems.push(`missing ${String(s)}`);
    }
    if (Array.isArray(spec.contains_any) && spec.contains_any.length > 0) {
      if (!spec.contains_any.some((s) => text.includes(nfc(String(s))))) problems.push('contains_any missed');
    }
    if (Array.isArray(spec.not_contains)) {
      for (const s of spec.not_contains) if (text.includes(nfc(String(s)))) problems.push(`contains ${String(s)}`);
    }
    if (Array.isArray(spec.not_contains_regex)) {
      for (const s of spec.not_contains_regex) {
        const re = new RegExp(String(s));
        if (re.test(text)) problems.push(`regex ${String(s)}`);
      }
    }
    if (spec.no_tags === true && tagGuard(reply.text).length > 0) problems.push('tags');
    if (spec.booking_claim === false) {
      const booked = events.some((e) => e.type === 'booking.confirmed' && e.seq < reply.seq);
      const hits = bookingClaimGuard(reply.text, booked);
      if (hits.length > 0) problems.push(`booking_claim ${hits.join(',')}`);
    }
    if (spec.numbers_subset_of_tool_results === true) {
      const session = ctx.sessions[Number(events[0]?.payload.__session ?? 0)] ?? ctx.sessions[0];
      const hits = numberGuard(reply.text, allowSets((session?.events ?? events) as unknown as Ev[]));
      if (hits.length > 0) problems.push(`numbers ${hits.join(',')}`);
    }
  }
  if (soft) reports.push(`final_reply soft: ${problems.join('; ') || 'ok'}`);
  else failures.push(...problems.map((p) => `final_reply: ${p}`));
}

function repliesOfEachTurn(
  ctx: AssertContext,
  spec: Record<string, unknown>,
): { text: string; seq: number; runId: string }[] {
  const turn =
    typeof spec.turn === 'number' ? [spec.turn] : ctx.turns.filter((t) => t.kind === 'user').map((t) => t.index);
  const out: { text: string; seq: number; runId: string }[] = [];
  for (const n of turn) {
    const ev = scopeEvents(ctx, { turn: n });
    const replies = finalReplies(ev);
    const last = replies[replies.length - 1];
    if (last) out.push(last);
    else out.push({ text: '', seq: -1, runId: '' });
  }
  return out;
}

function implicit(ctx: AssertContext, failures: string[]): void {
  const all = eventsOf(ctx);
  if (!ctx.hasSimulateClick && all.some((e) => e.type === 'booking.confirmed')) {
    failures.push('I1 booking.confirmed without simulate_click');
  }
  const { calls, results } = parseTools(all);
  for (const call of calls) {
    if (call.name !== 'quote_route') continue;
    const result = results.find((r) => r.toolCallId === call.id);
    if (!result || result.isError) continue;
    const from = String(call.args.from ?? '');
    const to = String(call.args.to ?? '');
    const oracle = oracleRoute(from, to);
    const diff = quoteDataMatches(result.data, oracle);
    if (diff) failures.push(`I2 ${from}->${to}: ${diff}`);
    if (!ctx.cities.includes(from) || !ctx.cities.includes(to))
      failures.push(`I5 quote args not canonical: ${from} -> ${to}`);
  }
  for (const e of all) {
    if (e.type !== 'agent.message' || e.payload.role !== 'assistant') continue;
    const view = String(e.payload.viewText ?? '');
    const process = String(e.payload.processText ?? '');
    if (tagGuard(view).length > 0 || tagGuard(process).length > 0) failures.push(`I3 tag at seq ${e.seq}`);
  }
  if (!ctx.expectsRunFailed && all.some((e) => e.type === 'agent.run_failed')) {
    failures.push('I4 agent.run_failed');
  }
  for (const turn of ctx.turns.filter((t) => t.kind === 'user')) {
    const ids = runIdsForTurn(ctx, turn.index);
    if (ids.size === 0) {
      failures.push(`I4 turn ${turn.index} has no run`);
      continue;
    }
    for (const id of ids) {
      const ended = all.some(
        (e) => (e.type === 'agent.run_completed' || e.type === 'agent.run_failed') && e.payload.runId === id,
      );
      if (!ended) failures.push(`I4 run ${id} has no ending`);
    }
  }
}

export function evaluate(ctx: AssertContext, expects: Record<string, unknown>[]): AssertOutcome {
  const failures: string[] = [];
  const reports: string[] = [];
  const all = eventsOf(ctx);
  implicit(ctx, failures);
  for (const rawSpec of expects) {
    const spec = fillValue(rawSpec, ctx.placeholders) as Record<string, unknown>;
    const key = Object.keys(spec).find((k) => k !== 'turn' && k !== 'session');
    if (!key) continue;
    const body = asRec(spec[key]) ?? {};
    const events = scopeEvents(ctx, spec);
    const tools = parseTools(events);
    if (key === 'event_absent') {
      if (events.some((e) => e.type === body.type)) failures.push(`event_absent ${String(body.type)}`);
    } else if (key === 'event_present') {
      const hits = events.filter(
        (e) => e.type === body.type && (body.payload === undefined || subset(e.payload, body.payload)),
      );
      const min = typeof body.min === 'number' ? body.min : 1;
      if (hits.length < min) failures.push(`event_present ${String(body.type)} ${hits.length}<${min}`);
    } else if (key === 'event_count') {
      const n = events.filter((e) => e.type === body.type).length;
      if (n !== body.eq) failures.push(`event_count ${String(body.type)} impl=${n} case=${String(body.eq)}`);
    } else if (key === 'tool_called') {
      const matched = tools.calls.filter((c) => {
        if (c.name !== body.name) return false;
        if (body.args && !argsMatch(asRec(body.args) ?? {}, c.args)) return false;
        if (typeof body.ok === 'boolean') {
          const result = tools.results.find((r) => r.toolCallId === c.id);
          const ok = result !== undefined && result.isError === false;
          if (ok !== body.ok) return false;
        }
        return true;
      });
      const min = typeof body.min === 'number' ? body.min : body.max === 0 ? 0 : 1;
      const max = typeof body.max === 'number' ? body.max : Number.POSITIVE_INFINITY;
      if (matched.length < min || matched.length > max) {
        failures.push(
          `tool_called ${String(body.name)} count=${matched.length} range=${min}..${max === Infinity ? 'inf' : max}`,
        );
      }
    } else if (key === 'tool_order') {
      const want = Array.isArray(spec.tool_order) ? spec.tool_order.map(String) : [];
      let i = 0;
      for (const c of tools.calls) if (c.name === want[i]) i++;
      if (i !== want.length) failures.push(`tool_order ${want.join(',')}`);
    } else if (key === 'tool_result') {
      const matched = tools.results.filter((r) => {
        if (body.name !== '*' && r.name !== body.name) return false;
        if (typeof body.ok === 'boolean' && (r.isError === false) !== body.ok) return false;
        if (typeof body.is_error === 'boolean' && r.isError !== body.is_error) return false;
        if (typeof body.text_prefix === 'string' && !r.text.startsWith(body.text_prefix)) return false;
        return true;
      });
      const min = typeof body.min === 'number' ? body.min : body.max === 0 ? 0 : 1;
      const max = typeof body.max === 'number' ? body.max : Number.POSITIVE_INFINITY;
      if (matched.length < min || matched.length > max)
        failures.push(`tool_result ${String(body.name)} count=${matched.length}`);
    } else if (key === 'quote_matches_oracle') {
      const from = String(body.from);
      const to = String(body.to);
      const hits = tools.calls.filter(
        (c) =>
          c.name === 'quote_route' &&
          nfc(String(c.args.from ?? '')) === nfc(from) &&
          nfc(String(c.args.to ?? '')) === nfc(to),
      );
      const okHits = hits.filter((c) => tools.results.some((r) => r.toolCallId === c.id && !r.isError));
      if (okHits.length === 0) failures.push(`quote_matches_oracle no success ${from}->${to}`);
      for (const c of okHits) {
        const result = tools.results.find((r) => r.toolCallId === c.id);
        const diff = quoteDataMatches(result?.data, oracleRoute(from, to));
        if (diff) failures.push(`quote_matches_oracle ${diff}`);
      }
    } else if (key === 'quote_offered_not') {
      const id = String(body.quoteId);
      if (events.some((e) => e.type === 'quote.offered' && e.payload.quoteId === id))
        failures.push(`quote_offered_not ${id}`);
    } else if (key === 'no_run_between') {
      const booked = all.find((e) => e.type === String(body.after));
      const until = ctx.turns.find((t) => t.index === body.until_turn && t.kind === 'user');
      if (!booked || !until?.seq) failures.push('no_run_between missing anchor');
      else if (all.some((e) => e.type === 'agent.run_started' && e.seq > booked.seq && e.seq < (until.seq ?? 0))) {
        failures.push('no_run_between saw run_started');
      }
    } else if (key === 'final_reply') {
      checkFinal(ctx, events, body, failures, reports);
    } else if (key === 'tickets_unchanged') {
      if (all.some((e) => e.type === 'booking.confirmed')) failures.push('tickets_unchanged saw booking.confirmed');
      if (ctx.ticketsBefore !== ctx.ticketsAfter) {
        failures.push(`tickets_unchanged count ${ctx.ticketsBefore}->${ctx.ticketsAfter}`);
      }
    } else if (key === 'user_message_escaped') {
      const mark = ctx.turns.find((t) => t.index === body.turn && t.kind === 'user');
      const ev = all.find((e) => e.type === 'user.message' && e.seq === mark?.seq);
      const text = String(ev?.payload.text ?? '');
      if (/<\s*\/?\s*(system_event|run_context)\b/i.test(text))
        failures.push(`user_message_escaped turn ${String(body.turn)}`);
    } else if (key === 'no_prompt_leak') {
      const n = Number(body.min_overlap_chars);
      const replies = finalReplies(events);
      const last = replies[replies.length - 1];
      if (!last) failures.push('no_prompt_leak no reply');
      else if (leaks(last.text, SYSTEM_PROMPT, n)) failures.push(`no_prompt_leak overlap>=${n}`);
    } else if (key === 'no_guard_violation') {
      if (events.some((e) => e.type === 'agent.guard_violation')) failures.push('no_guard_violation');
    } else if (key === 'guard_violation') {
      const hits = events.filter(
        (e) => e.type === 'agent.guard_violation' && (body.guard === undefined || e.payload.guard === body.guard),
      );
      const min = typeof body.min === 'number' ? body.min : 1;
      if (hits.length < min) failures.push(`guard_violation ${hits.length}<${min}`);
    } else if (key === 'report') {
      const guard = String(body.guard_violation ?? '');
      const hits = all.filter((e) => e.type === 'agent.guard_violation' && e.payload.guard === guard).length;
      reports.push(`guard_violation ${guard}: ${hits}`);
    } else if (key === 'saved_values_canonical') {
      for (const r of tools.results) {
        if (r.name !== 'save_preference' || r.isError) continue;
        const data = asRec(r.data);
        const k = String(data?.key ?? '');
        const v = String(data?.value ?? '');
        if (k !== 'home_city' && k !== 'preferred_language') failures.push(`saved key ${k}`);
        if (k === 'home_city' && !ctx.cities.includes(v)) failures.push(`saved city ${v}`);
        if (k === 'preferred_language' && v !== 'zh' && v !== 'en') failures.push(`saved lang ${v}`);
      }
    } else if (key === 'run_started_profile') {
      const absent = Array.isArray(body.absent) ? body.absent.map(String) : [];
      const starts = events.filter((e) => e.type === 'agent.run_started');
      if (starts.length === 0) failures.push('run_started_profile no run');
      for (const e of starts) {
        const profile = asRec(e.payload.profile) ?? {};
        for (const field of absent) if (profile[field] !== undefined) failures.push(`profile has ${field}`);
      }
    } else if (key === 'e2e') {
      failures.push('e2e case was executed by the agent runner');
    } else {
      failures.push(`runner has no assertion ${key}`);
    }
  }
  return { pass: failures.length === 0, failures, reports, modelCalls: modelCalls(all) };
}

export { modelCalls };
