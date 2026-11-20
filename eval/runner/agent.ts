// Live agent eval against the running site. One run per case. Model-call budget is a hard stop.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, modelCalls, type AssertContext, type LogEvent, type SessionLog, type TurnMark } from './assert.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const ORIGIN = 'http://127.0.0.1';
const API = `${ORIGIN}/api/v1`;
const TURN_TIMEOUT_MS = 180_000;

export interface AgentCaseResult {
  id: string;
  category: string;
  status: 'pass' | 'fail' | 'not_run' | 'aborted';
  reason?: string;
  failures?: string[];
  reports?: string[];
  modelCalls: number;
}

export interface AgentReport {
  modelCalls: number;
  budget: number;
  ran: AgentCaseResult[];
  notRun: { id: string; category: string; reason: string }[];
  stoppedBecause: string;
}

interface CaseDoc {
  id: string;
  lang?: string;
  runner?: string;
  threshold?: number;
  note?: string;
  setup?: Record<string, unknown>;
  turns?: unknown[];
  expect?: Record<string, unknown>[];
}

interface SuiteDoc {
  file: string;
  category: string;
  threshold?: number;
  defaults?: { setup?: Record<string, unknown> };
  cases: CaseDoc[];
}

function loadAgent(): SuiteDoc[] {
  const r = spawnSync('python', [join(here, 'load_yaml.py'), join(root, 'eval', 'cases', 'agent')], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`load agent yaml: ${r.stderr}`);
  const docs = JSON.parse(r.stdout) as { file: string; doc: SuiteDoc & { cases: CaseDoc[] } }[];
  return docs.map((d) => ({ ...d.doc, file: d.file, cases: d.doc.cases }));
}

function setupOf(suite: SuiteDoc, c: CaseDoc): Record<string, unknown> {
  const raw = c.setup ?? {};
  if (raw.inherit === 'defaults') {
    return { ...(suite.defaults?.setup ?? {}), ...raw, inherit: undefined };
  }
  return raw;
}

function blocked(setup: Record<string, unknown>): string | undefined {
  if (Array.isArray(setup.faults) && setup.faults.length > 0) {
    return '线上栈没有 hands/LLM 故障代理；不注入就跑会让断言在错误前提下执行';
  }
  if (setup.tickets || setup.other_users) return '线上栈没有预置历史票的测试夹具';
  if (setup.memories) return '线上栈没有预置记忆的写入夹具';
  return undefined;
}

class Site {
  sid = '';
  csrf = '';

  async login(username: string): Promise<void> {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) throw new Error(`login ${res.status}`);
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of cookies) {
      const sid = /fb_sid=([^;]+)/.exec(c);
      const csrf = /fb_csrf=([^;]+)/.exec(c);
      if (sid) this.sid = sid[1] ?? '';
      if (csrf) this.csrf = csrf[1] ?? '';
    }
    if (!this.sid || !this.csrf) throw new Error('login did not set session cookies');
  }

  private headers(json: boolean): Record<string, string> {
    return {
      origin: ORIGIN,
      cookie: `fb_sid=${this.sid}; fb_csrf=${this.csrf}`,
      'x-csrf-token': this.csrf,
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  async createSession(locale: string): Promise<string> {
    const res = await fetch(`${API}/sessions`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ locale }),
    });
    if (res.status !== 201) throw new Error(`create session ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { session: { id: string } };
    return body.session.id;
  }

  async postMessage(sessionId: string, text: string): Promise<number> {
    const res = await fetch(`${API}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ text, clientMessageId: randomUUID() }),
    });
    if (res.status !== 202 && res.status !== 200) throw new Error(`message ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { event: { seq: number } };
    return body.event.seq;
  }

  async confirm(quoteId: string): Promise<{ ticketNo: string; quoteId: string }> {
    const res = await fetch(`${API}/quotes/${quoteId}/confirm`, { method: 'POST', headers: this.headers(false) });
    if (res.status !== 201 && res.status !== 200) throw new Error(`confirm ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { ticket: { ticketNo: string; quoteId: string } };
    return { ticketNo: body.ticket.ticketNo, quoteId: body.ticket.quoteId };
  }

  async ticketCount(): Promise<number> {
    const res = await fetch(`${API}/tickets?limit=50`, { headers: { cookie: `fb_sid=${this.sid}` } });
    if (!res.ok) throw new Error(`tickets ${res.status}`);
    const body = (await res.json()) as { items: unknown[] };
    return body.items.length;
  }

  async sessionStatus(sessionId: string): Promise<string> {
    const res = await fetch(`${API}/sessions/${sessionId}`, { headers: { cookie: `fb_sid=${this.sid}` } });
    if (!res.ok) throw new Error(`session ${res.status}`);
    const body = (await res.json()) as { session: { status: string } };
    return body.session.status;
  }

  async publicEvents(sessionId: string): Promise<LogEvent[]> {
    const out: LogEvent[] = [];
    let after = 0;
    for (;;) {
      const res = await fetch(`${API}/sessions/${sessionId}/events?afterSeq=${after}&limit=200`, {
        headers: { cookie: `fb_sid=${this.sid}` },
      });
      if (!res.ok) throw new Error(`public events ${res.status}`);
      const body = (await res.json()) as { events: LogEvent[]; hasMore: boolean };
      out.push(...body.events);
      if (!body.hasMore || body.events.length === 0) break;
      after = body.events[body.events.length - 1]!.seq;
    }
    return out;
  }
}

const eventsScript = readFileSync(join(here, 'fetch-events.mjs'));

function internalEvents(sessionId: string): LogEvent[] {
  // The harness rootfs is read-only, so the script is piped to node instead of copied in.
  const r = spawnSync(
    'docker',
    ['exec', '-i', '-e', `EVAL_SID=${sessionId}`, 'ocean-above-harness-1', 'node', '--input-type=module', '-'],
    { input: eventsScript, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`internal events failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as LogEvent[];
}

async function waitIdle(site: Site, sessionId: string, seq: number): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await site.sessionStatus(sessionId);
    if (status === 'idle' || status === 'error') {
      // Public events omit inputSeqs. A completion with a higher seq is this turn's outcome.
      const events = await site.publicEvents(sessionId);
      const ended = events.some(
        (e) => (e.type === 'agent.run_completed' || e.type === 'agent.run_failed') && e.seq > seq,
      );
      if (ended) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`);
}

function lastQuoteId(events: LogEvent[]): string | undefined {
  let id: string | undefined;
  for (const e of events)
    if (e.type === 'quote.offered' && typeof e.payload.quoteId === 'string') id = e.payload.quoteId;
  return id;
}

export async function runAgent(budget = 20): Promise<AgentReport> {
  const suites = loadAgent();
  const byCat = new Map(suites.map((s) => [s.category, s]));
  const notRun: AgentReport['notRun'] = [];
  const queue: { suite: SuiteDoc; case: CaseDoc }[] = [];
  const queued = new Set<string>();
  const consider = (suite: SuiteDoc, c: CaseDoc, priority: boolean): void => {
    if (c.runner === 'e2e') {
      notRun.push({
        id: c.id,
        category: suite.category,
        reason: 'runner: e2e，引用 T15 合并 5459a7f（6 条浏览器旅程通过），不重跑',
      });
      return;
    }
    const why = blocked(setupOf(suite, c));
    if (why) {
      notRun.push({ id: c.id, category: suite.category, reason: why });
      return;
    }
    if (!priority && c.id !== 'route-001') return;
    queue.push({ suite, case: c });
    queued.add(c.id);
  };
  for (const cat of ['confirm_flow', 'numbers', 'redteam', 'failure']) {
    const suite = byCat.get(cat);
    if (!suite) continue;
    for (const c of suite.cases) consider(suite, c, true);
  }
  const route = byCat.get('route');
  const route001 = route?.cases.find((c) => c.id === 'route-001');
  if (route && route001 && !queued.has(route001.id)) consider(route, route001, true);
  for (const suite of suites) {
    for (const c of suite.cases) {
      if (queued.has(c.id) || notRun.some((n) => n.id === c.id)) continue;
      if (c.runner === 'e2e') {
        notRun.push({
          id: c.id,
          category: suite.category,
          reason: 'runner: e2e，引用 T15 合并 5459a7f（6 条浏览器旅程通过），不重跑',
        });
        continue;
      }
      notRun.push({ id: c.id, category: suite.category, reason: '不在本次优先顺序里' });
    }
  }

  const cities: string[] = [];
  {
    const { loadNetwork } = await import('../../packages/flight-core/src/data.ts');
    const { readFileSync } = await import('node:fs');
    const net = loadNetwork(join(root, 'locations.db'), readFileSync(join(root, 'locations.db')));
    for (const n of net.nodes) cities.push(n.city.name);
  }
  const health = await fetch(`${API}/healthz`);
  if (!health.ok) throw new Error(`site health ${health.status}`);
  const probe = new Site();
  await probe.login(`eprobe${randomBytes(3).toString('hex')}`);
  const probeId = await probe.createSession('zh');
  internalEvents(probeId);
  const ran: AgentCaseResult[] = [];
  let used = 0;
  let lastTurnCalls = 4;
  let stoppedBecause = '队列跑完';

  for (const item of queue) {
    if (used + lastTurnCalls > budget) {
      stoppedBecause = `下一条预计会超过 ${budget} 次模型调用（已用 ${used}，上一条用户回合 ${lastTurnCalls} 次）`;
      notRun.push({ id: item.case.id, category: item.suite.category, reason: stoppedBecause });
      continue;
    }
    let result: AgentCaseResult;
    try {
      result = await runOne(
        item.suite,
        item.case,
        cities,
        () => used,
        () => lastTurnCalls,
        budget,
        (n) => {
          lastTurnCalls = Math.max(1, n);
          used += n;
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stoppedBecause = reason;
      ran.push({ id: item.case.id, category: item.suite.category, status: 'aborted', reason, modelCalls: 0 });
      for (const rest of queue.slice(queue.indexOf(item) + 1)) {
        notRun.push({ id: rest.case.id, category: rest.suite.category, reason });
      }
      break;
    }
    console.error(`${result.id} ${result.status} calls=${result.modelCalls} total=${used}`);
    if (result.status === 'aborted') {
      stoppedBecause = result.reason ?? stoppedBecause;
      ran.push(result);
      for (const rest of queue.slice(queue.indexOf(item) + 1)) {
        if (!notRun.some((n) => n.id === rest.case.id)) {
          notRun.push({ id: rest.case.id, category: rest.suite.category, reason: stoppedBecause });
        }
      }
      break;
    }
    ran.push(result);
    if (used >= budget) {
      stoppedBecause = `已用 ${used} 次，达到上限 ${budget}`;
      for (const rest of queue.slice(queue.indexOf(item) + 1)) {
        notRun.push({ id: rest.case.id, category: rest.suite.category, reason: stoppedBecause });
      }
      break;
    }
  }

  const seen = new Set<string>();
  const deduped = notRun.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
  return { modelCalls: used, budget, ran, notRun: deduped, stoppedBecause };
}

async function runOne(
  suite: SuiteDoc,
  c: CaseDoc,
  cities: readonly string[],
  used: () => number,
  estimate: () => number,
  budget: number,
  addCalls: (n: number) => void,
): Promise<AgentCaseResult> {
  const setup = setupOf(suite, c);
  const locale = setup.session_locale === 'en' ? 'en' : 'zh';
  const site = new Site();
  const username = `e${c.id.replace(/[^a-z0-9]/gi, '').toLowerCase()}${randomBytes(3).toString('hex')}`.slice(0, 32);
  await site.login(username);
  const ticketsBefore = await site.ticketCount();
  const sessions: SessionLog[] = [];
  const turns: TurnMark[] = [];
  let session = 0;
  sessions.push({ index: 0, id: await site.createSession(locale), events: [] });
  let booking: { ticketNo: string; quoteId: string } | undefined;
  const hasSimulateClick = (c.turns ?? []).some((t) => asTurn(t).kind === 'click');
  let caseCalls = 0;

  for (let i = 0; i < (c.turns ?? []).length; i++) {
    const turn = asTurn((c.turns ?? [])[i]);
    const index = i + 1;
    if (turn.kind === 'new_session') {
      session += 1;
      sessions.push({ index: session, id: await site.createSession(locale), events: [] });
      turns.push({ index, kind: 'new_session', session });
      continue;
    }
    if (turn.kind === 'click') {
      const events = await site.publicEvents(sessions[session]!.id);
      const quoteId = lastQuoteId(events);
      if (!quoteId) throw new Error(`${c.id} simulate_click found no quote.offered`);
      booking = await site.confirm(quoteId);
      turns.push({ index, kind: 'click', session });
      continue;
    }
    if (turn.kind !== 'user') {
      turns.push({ index, kind: 'other', session });
      continue;
    }
    if (i > 0 && used() + estimate() > budget) {
      return {
        id: c.id,
        category: suite.category,
        status: 'aborted',
        reason: `跑到第 ${index} 个 turn 前已用 ${used()} 次，按上一回合 ${estimate()} 次估计会超过 ${budget}`,
        modelCalls: caseCalls,
      };
    }
    const before = modelCalls(internalEvents(sessions[session]!.id));
    const seq = await site.postMessage(sessions[session]!.id, turn.text);
    try {
      await waitIdle(site, sessions[session]!.id, seq);
    } catch (err) {
      sessions[session]!.events = internalEvents(sessions[session]!.id);
      const delta = Math.max(0, modelCalls(sessions[session]!.events) - before);
      addCalls(delta);
      caseCalls += delta;
      return {
        id: c.id,
        category: suite.category,
        status: 'fail',
        reason: err instanceof Error ? err.message : String(err),
        failures: ['turn timeout'],
        modelCalls: caseCalls,
      };
    }
    const afterEvents = internalEvents(sessions[session]!.id);
    const delta = Math.max(0, modelCalls(afterEvents) - before);
    addCalls(delta);
    caseCalls += delta;
    turns.push({ index, kind: 'user', session, seq });
    if (used() > budget) {
      sessions[session]!.events = afterEvents;
      return {
        id: c.id,
        category: suite.category,
        status: 'aborted',
        reason: `本回合后模型调用达到 ${used()}，超过上限 ${budget}，本条不计入通过率`,
        modelCalls: caseCalls,
      };
    }
  }

  for (const s of sessions) s.events = internalEvents(s.id);
  const ticketsAfter = await site.ticketCount();
  const expectsRunFailed = (c.expect ?? []).some((e) => JSON.stringify(e).includes('agent.run_failed'));
  const ctx: AssertContext = {
    sessions,
    turns,
    placeholders: {
      'booking.last.ticketNo': booking?.ticketNo ?? '',
      'booking.last.quoteId': booking?.quoteId ?? '',
    },
    ticketsBefore,
    ticketsAfter,
    hasSimulateClick,
    category: suite.category,
    expectsRunFailed: expectsRunFailed || suite.category === 'failure',
    cities,
  };
  let outcome: ReturnType<typeof evaluate>;
  try {
    outcome = evaluate(ctx, c.expect ?? []);
  } catch (err) {
    return {
      id: c.id,
      category: suite.category,
      status: 'fail',
      reason: err instanceof Error ? err.message : String(err),
      failures: ['assert threw'],
      modelCalls: caseCalls,
    };
  }
  return {
    id: c.id,
    category: suite.category,
    status: outcome.pass ? 'pass' : 'fail',
    failures: outcome.failures,
    reports: outcome.reports,
    modelCalls: caseCalls,
  };
}

function asTurn(raw: unknown): { kind: 'user' | 'new_session' | 'click' | 'other'; text: string } {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (typeof rec.user === 'string') return { kind: 'user', text: rec.user };
  if ('new_session' in rec) return { kind: 'new_session', text: '' };
  if ('simulate_click' in rec) return { kind: 'click', text: '' };
  return { kind: 'other', text: '' };
}
