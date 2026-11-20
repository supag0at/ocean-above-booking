// Deterministic eval (no model calls). Dispatches each case to the product function and
// records numeric disagreements with eval/oracle without picking a winner.
import { spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { checkToolArgs } from '../../packages/contracts/src/tools/index.ts';
import { escapeUserText } from '../../packages/contracts/src/server/escape.ts';
import { formatKm } from '../../packages/contracts/src/web/format.ts';
import { createFlightCore } from '../../packages/flight-core/src/index.ts';
import { loadNetwork } from '../../packages/flight-core/src/data.ts';
import { canonicalCity } from '../../services/hands/src/tools/preferences.ts';
import { bookingClaimGuard, numberGuard, tagGuard, type AllowSets } from '../../services/harness/src/guards.ts';
import { cjkRatio, langOfText } from '../../services/harness/src/lang.ts';
import {
  renderBookingConfirmed,
  renderBookingFailed,
  renderGuardNotice,
  renderRunContext,
} from '../../services/harness/src/render.ts';
import { recallPreferences } from '../../packages/memory/src/recall.ts';
import type { MemoryDeletionRow, MemoryKey, MemoryRow } from '../../packages/memory/src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

export interface CaseResult {
  id: string;
  fn: string;
  pass: boolean;
  detail?: string;
}

export interface OracleNote {
  id: string;
  kind: string;
  caseValue: unknown;
  oracleValue: unknown;
  implValue?: unknown;
}

export interface DeterministicReport {
  total: number;
  passed: number;
  failed: CaseResult[];
  oracleDisagreements: OracleNote[];
  property: Record<string, unknown>;
}

interface YamlCase {
  id: string;
  fn: string;
  input: unknown;
  expect: unknown;
  note?: string;
}

function loadSuites(): { file: string; cases: YamlCase[] }[] {
  const r = spawnSync('python', [join(here, 'load_yaml.py'), join(root, 'eval', 'cases', 'deterministic')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`load_yaml failed: ${r.stderr}`);
  const docs = JSON.parse(r.stdout) as { file: string; doc: { cases: YamlCase[] } }[];
  return docs.map((d) => ({ file: d.file, cases: d.doc.cases }));
}

function sets(i: { A_price: string[]; A_dist: string[]; A_sys_extra: string[] }): AllowSets {
  const n2 = (xs: string[]) => xs.map((x) => Number(x.replace(/[,\u00A0 ]/g, '')).toFixed(2));
  return {
    price: new Set(n2(i.A_price)),
    dist: new Set(n2(i.A_dist)),
    sys: new Set(n2([...i.A_price, ...i.A_dist, ...i.A_sys_extra])),
  };
}

function numClose(a: number, b: number): boolean {
  return Object.is(a, b) || Math.abs(a - b) < 1e-6;
}

/** Subset compare: every key/index in `exp` must match `got`. Extra got fields are ignored. */
function mismatch(got: unknown, exp: unknown, path = '$'): string | undefined {
  if (typeof exp === 'number' && typeof got === 'number') {
    return numClose(got, exp) ? undefined : `${path}: impl=${got} case=${exp}`;
  }
  if (exp === null || typeof exp !== 'object') {
    return Object.is(got, exp) ? undefined : `${path}: impl=${JSON.stringify(got)} case=${JSON.stringify(exp)}`;
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(got)) return `${path}: impl is not an array`;
    if (got.length !== exp.length) return `${path}: length impl=${got.length} case=${exp.length}`;
    for (let i = 0; i < exp.length; i++) {
      const m = mismatch(got[i], exp[i], `${path}[${i}]`);
      if (m) return m;
    }
    return undefined;
  }
  if (got === null || typeof got !== 'object') return `${path}: impl is not an object`;
  const g = got as Record<string, unknown>;
  for (const [k, v] of Object.entries(exp as Record<string, unknown>)) {
    const m = mismatch(g[k], v, `${path}.${k}`);
    if (m) return m;
  }
  return undefined;
}

function quoteActual(core: ReturnType<typeof createFlightCore>, input: { from: string; to: string }): unknown {
  const r = core.quoteRoute(input.from, input.to);
  if (r.ok) {
    return {
      ok: true,
      path: [r.route.from, ...r.route.transferCities, r.route.to],
      ...r.route,
    };
  }
  if (r.code === 'CITY_NOT_SERVED') {
    const city = !core.isServed(input.from) ? input.from : input.to;
    return { ok: false, code: r.code, data: { city, nearestServed: r.nearestServed ?? null } };
  }
  return { ok: false, code: r.code };
}

function runCase(core: ReturnType<typeof createFlightCore>, names: readonly string[], c: YamlCase): CaseResult {
  try {
    const exp = c.expect;
    if (c.fn === 'quote') {
      const got = quoteActual(core, c.input as { from: string; to: string });
      const m = mismatch(got, exp);
      return m ? { id: c.id, fn: c.fn, pass: false, detail: m } : { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'norm') {
      const got = core.normalize(c.input as string);
      return got === exp
        ? { id: c.id, fn: c.fn, pass: true }
        : { id: c.id, fn: c.fn, pass: false, detail: `impl=${JSON.stringify(got)} case=${JSON.stringify(exp)}` };
    }
    if (c.fn === 'normCollisions') {
      const groups = new Map<string, string[]>();
      for (const n of names) {
        const k = core.normalize(n);
        groups.set(k, [...(groups.get(k) ?? []), n]);
      }
      const collided = [...groups.values()].filter((g) => g.length > 1).flat();
      const want = new Set(exp as string[]);
      const got = new Set(collided);
      const same = want.size === got.size && [...want].every((x) => got.has(x));
      return same
        ? { id: c.id, fn: c.fn, pass: true }
        : { id: c.id, fn: c.fn, pass: false, detail: `impl=${[...got].join(',')} case=${[...want].join(',')}` };
    }
    if (c.fn === 'allAsciiAfterNorm') {
      const got = names.every((n) => /^[\x20-\x7e]*$/u.test(core.normalize(n)));
      return got === exp
        ? { id: c.id, fn: c.fn, pass: true }
        : { id: c.id, fn: c.fn, pass: false, detail: `impl=${got}` };
    }
    if (c.fn === 'resolve_city') {
      const r = core.resolveCity(c.input as { original: string; candidates: string[] });
      const got = { status: r.status, matches: r.matches, ...(r.matchedBy ? { matchedBy: r.matchedBy } : {}) };
      const m = mismatch(got, exp);
      return m ? { id: c.id, fn: c.fn, pass: false, detail: m } : { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'resolve_city.schema' || c.fn === 'save_preference.schema') {
      const name = c.fn.startsWith('resolve') ? 'resolve_city' : 'save_preference';
      const check = checkToolArgs(name, c.input);
      const rejected = check.ok ? undefined : 'INVALID_INPUT';
      const want = (exp as { rejected?: string }).rejected;
      return rejected === want
        ? { id: c.id, fn: c.fn, pass: true }
        : { id: c.id, fn: c.fn, pass: false, detail: `impl=${rejected ?? 'accepted'} case=${want}` };
    }
    if (c.fn === 'save_preference') {
      const { value } = c.input as { key: string; value: string };
      const want = exp as { ok: boolean; stored?: string; code?: string; candidates?: string[] };
      const city = canonicalCity(core, value);
      if (want.ok) {
        const ok = city.ok && city.city === want.stored;
        return ok
          ? { id: c.id, fn: c.fn, pass: true }
          : { id: c.id, fn: c.fn, pass: false, detail: JSON.stringify(city) };
      }
      if (city.ok) return { id: c.id, fn: c.fn, pass: false, detail: `impl stored ${city.city}` };
      if (city.response.ok) return { id: c.id, fn: c.fn, pass: false, detail: 'save_preference returned ok' };
      const code = city.response.error.code;
      const rawCandidates = city.response.error.data?.candidates;
      const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
      const m1 = code === want.code ? undefined : `code impl=${code} case=${want.code}`;
      const m2 =
        want.candidates === undefined || mismatch(candidates, want.candidates) === undefined
          ? undefined
          : `candidates impl=${JSON.stringify(candidates)} case=${JSON.stringify(want.candidates)}`;
      const detail = [m1, m2].filter(Boolean).join('; ');
      return detail ? { id: c.id, fn: c.fn, pass: false, detail } : { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'memory.effective') {
      const input = c.input as {
        rows: { key: string; value: string | null; seq: number }[];
        memory_deletions?: { key: string; seq: number }[];
      };
      const userId = 'eval';
      const rows: MemoryRow[] = input.rows.map((row) => ({
        id: `m_${row.seq}`,
        userId,
        key: row.key as MemoryKey,
        value: row.value,
        sourceSessionId: 's',
        sourceSeq: row.seq,
        createdAt: new Date(1_700_000_000_000 + row.seq * 1000).toISOString(),
      }));
      const deletions: MemoryDeletionRow[] = (input.memory_deletions ?? []).map((d) => ({
        memoryId: `m_${d.seq}`,
        userId,
      }));
      const recalled = recallPreferences(userId, rows, deletions);
      const got: Record<string, string | null> = {};
      for (const key of Object.keys(exp as object)) {
        const hit = recalled[key as MemoryKey];
        got[key] = hit ? hit.value : null;
      }
      const m = mismatch(got, exp);
      return m ? { id: c.id, fn: c.fn, pass: false, detail: m } : { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'nearestServed') {
      const { city } = c.input as { city: string };
      const nearest = core.nearestServed(city);
      const got = { served: core.isServed(city), nearestServed: nearest };
      const want = { ...(exp as object) } as Record<string, unknown>;
      delete want.secondNearest;
      delete want.rawDistanceKm;
      const m = mismatch(got, want);
      return m ? { id: c.id, fn: c.fn, pass: false, detail: m } : { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'unservedSet') {
      const unserved = names.filter((n) => !core.isServed(n));
      const hubs = names.filter((n) => core.getCity(n)?.isHub).length;
      const want = exp as { unserved: string[]; count: number; cities: number; hubs: number; hubLinks: number };
      const links = hubLinkRows();
      const m = mismatch(
        { unserved, count: unserved.length, cities: names.length, hubs, hubLinks: links },
        { unserved: want.unserved, count: want.count, cities: want.cities, hubs: want.hubs, hubLinks: want.hubLinks },
      );
      return m ? { id: c.id, fn: c.fn, pass: false, detail: m } : { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'numberGuard' || c.fn === 'bookingClaimGuard' || c.fn === 'tagGuard') {
      const input = c.input as { text: string; bookingConfirmedInProjection?: boolean };
      let hits: string[];
      if (c.fn === 'numberGuard') hits = numberGuard(input.text, sets(c.input as never));
      else if (c.fn === 'bookingClaimGuard')
        hits = bookingClaimGuard(input.text, input.bookingConfirmedInProjection === true);
      else hits = tagGuard(input.text);
      const want = exp as { violation: boolean; offending?: string[] };
      if (hits.length > 0 !== want.violation) {
        return {
          id: c.id,
          fn: c.fn,
          pass: false,
          detail: `impl hits=${JSON.stringify(hits)} case.violation=${want.violation}`,
        };
      }
      if (Array.isArray(want.offending)) {
        const m = mismatch(hits, want.offending, 'offending');
        if (m) return { id: c.id, fn: c.fn, pass: false, detail: m };
      }
      return { id: c.id, fn: c.fn, pass: true };
    }
    if (c.fn === 'escapeUserText') {
      const got = escapeUserText(c.input as string);
      return got === exp
        ? { id: c.id, fn: c.fn, pass: true }
        : { id: c.id, fn: c.fn, pass: false, detail: `impl=${JSON.stringify(got)} case=${JSON.stringify(exp)}` };
    }
    if (c.fn === 'detectLang') {
      const text = c.input as string;
      const want = exp as { lang: string | null; cjkRatio: number };
      const lang = langOfText(text) ?? null;
      const ratio = Math.round((cjkRatio(text) ?? 0) * 10000) / 10000;
      const langOk = lang === want.lang;
      const ratioOk = Math.abs(ratio - want.cjkRatio) < 5e-5;
      if (langOk && ratioOk) return { id: c.id, fn: c.fn, pass: true };
      return {
        id: c.id,
        fn: c.fn,
        pass: false,
        detail: `impl lang=${lang} ratio=${ratio} case lang=${want.lang} ratio=${want.cjkRatio}`,
      };
    }
    if (c.fn.startsWith('render')) {
      const got = renderOf(c.fn, c.input);
      return got === exp
        ? { id: c.id, fn: c.fn, pass: true }
        : { id: c.id, fn: c.fn, pass: false, detail: `impl=${JSON.stringify(got)}\ncase=${JSON.stringify(exp)}` };
    }
    if (c.fn.startsWith('property.')) {
      return { id: c.id, fn: c.fn, pass: true, detail: 'checked in the sweep' };
    }
    return { id: c.id, fn: c.fn, pass: false, detail: `runner has no dispatch for ${c.fn}` };
  } catch (err) {
    return { id: c.id, fn: c.fn, pass: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function renderOf(fn: string, input: unknown): string {
  const i = input as Record<string, unknown>;
  if (fn === 'renderBookingConfirmed') {
    const route = i.route as string[];
    const legs = route.slice(1).map((to, k) => ({ from: route[k] as string, to }));
    const display = i.display as { totalDistanceKm: string; priceUsd: string; legs: string[] };
    return renderBookingConfirmed({
      quoteId: i.quoteId as string,
      ticketId: i.ticketId as string,
      ticketNo: i.ticketNo as string,
      summary: {
        ticketNo: i.ticketNo as string,
        from: route[0] as string,
        to: route[route.length - 1] as string,
        legs,
        transferCities: route.slice(1, -1),
        display,
      },
    });
  }
  if (fn === 'renderBookingFailed') return renderBookingFailed(i as never);
  if (fn === 'renderRunContext') {
    return renderRunContext({
      runId: 'run_00000000000000000000000000',
      inputSeqs: [1],
      consumedUpToSeq: 1,
      model: 'm',
      promptVersion: 'p',
      projectorVersion: 'x',
      piVersion: 'x',
      ...(i as object),
    } as never);
  }
  if (fn === 'renderGuardNotice') {
    return renderGuardNotice({
      runId: 'run_00000000000000000000000000',
      attempt: 1,
      n: 0,
      messageKey: 'm',
      action: 'regenerate',
      ...(i as object),
    } as never);
  }
  if (fn === 'renderUserText') return escapeUserText(input as string);
  throw new Error(`unknown render ${fn}`);
}

function hubLinkRows(): number {
  const db = new DatabaseSync(join(root, 'locations.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT count(*) AS n FROM hub_links').get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

interface Sweep {
  pairs: number;
  hist: Record<string, number>;
  symmetryBad: number;
  symmetryExample?: string;
  nonHubTransfer: number;
  nonHubExample?: string;
  directEdges: number;
  directBad: number;
  directExample?: string;
  priceRoundDiff: number;
  oraclePathDiff: number;
  oraclePriceDiff: number;
  oracleKmDiff: number;
  oracleExamples: OracleNote[];
  missingOracle: number;
}

async function sweep(
  core: ReturnType<typeof createFlightCore>,
  names: readonly string[],
  dumpPath: string,
): Promise<Sweep> {
  const served = names.filter((n) => core.isServed(n));
  const isHub = new Set(names.filter((n) => core.getCity(n)?.isHub));
  const byKey = new Map<string, { path: string[]; price: number; km: number }>();
  const hist: Record<string, number> = {};
  let symmetryBad = 0;
  let symmetryExample: string | undefined;
  let nonHubTransfer = 0;
  let nonHubExample: string | undefined;
  let directBad = 0;
  let directExample: string | undefined;
  let priceRoundDiff = 0;
  const seenUnordered = new Set<string>();

  const dbPath = join(root, 'locations.db');
  const net = loadNetwork(dbPath, readFileSync(dbPath));
  const edges: [string, string][] = [];
  net.nodes.forEach((node, i) => {
    for (const e of net.adj[i] ?? []) {
      if (e.to > i) edges.push([node.city.name, net.nodes[e.to]!.city.name]);
    }
  });
  const directEdges = edges.length;
  for (const [a, b] of edges) {
    const r = core.quoteRoute(a, b);
    const legs = r.ok ? r.route.legs.length : -1;
    if (legs !== 1) {
      directBad++;
      directExample ??= `${a}->${b} legs=${legs}`;
    }
  }

  let quoted = 0;
  for (const a of served) {
    for (const b of served) {
      if (a === b) continue;
      const r = core.quoteRoute(a, b);
      quoted++;
      if (!r.ok) {
        symmetryBad++;
        symmetryExample ??= `${a}->${b} ${r.code}`;
        continue;
      }
      const path = [r.route.from, ...r.route.transferCities, r.route.to];
      byKey.set(`${a}\t${b}`, { path, price: r.route.priceCents, km: r.route.totalDistanceKm });
      const legs = String(r.route.legs.length);
      hist[legs] = (hist[legs] ?? 0) + 1;
      for (const city of r.route.transferCities) {
        if (!isHub.has(city)) {
          nonHubTransfer++;
          nonHubExample ??= `${a}->${b} via ${city}`;
        }
      }
      const uKey = a < b ? `${a}\t${b}` : `${b}\t${a}`;
      if (!seenUnordered.has(uKey)) {
        seenUnordered.add(uKey);
        const raw = r.route.totalDistanceKm;
        const rounded = Number(raw.toFixed(2));
        if (Math.round(raw * 13) !== Math.round(rounded * 13)) priceRoundDiff++;
      }
      if (quoted % 100000 === 0) process.stderr.write(`sweep ${quoted}\n`);
    }
  }
  for (const [key, rec] of byKey) {
    const [a, b] = key.split('\t');
    const back = byKey.get(`${b}\t${a}`);
    if (!back) {
      symmetryBad++;
      symmetryExample ??= `${a}->${b} missing reverse`;
      continue;
    }
    const rev = [...rec.path].reverse();
    if (rec.price !== back.price || rev.join('|') !== back.path.join('|')) {
      symmetryBad++;
      symmetryExample ??= `${a}->${b}`;
    }
  }

  let oraclePathDiff = 0;
  let oraclePriceDiff = 0;
  let oracleKmDiff = 0;
  let missingOracle = 0;
  const oracleExamples: OracleNote[] = [];
  const lines = createInterface({ input: createReadStream(dumpPath, { encoding: 'utf8' }) });
  let seen = 0;
  for await (const line of lines) {
    if (!line) continue;
    seen++;
    const [from, to, kmText, centsText, pathText] = line.split('\t');
    const impl = byKey.get(`${from}\t${to}`);
    const oraclePath = pathText?.split('|') ?? [];
    const oracleCents = Number(centsText);
    const oracleKm = Number(kmText);
    if (!impl) {
      missingOracle++;
      continue;
    }
    const implKm = impl.km;
    const pathSame = impl.path.join('|') === oraclePath.join('|');
    const priceSame = impl.price === oracleCents;
    const kmSame = numClose(implKm, oracleKm);
    if (!pathSame) oraclePathDiff++;
    if (!priceSame) oraclePriceDiff++;
    if (!kmSame) oracleKmDiff++;
    if ((!pathSame || !priceSame || !kmSame) && oracleExamples.length < 12) {
      oracleExamples.push({
        id: `${from} -> ${to}`,
        kind: 'route-sweep',
        caseValue: undefined,
        oracleValue: { path: oraclePath, priceCents: oracleCents, totalDistanceKm: oracleKm },
        implValue: { path: impl.path, priceCents: impl.price, totalDistanceKm: implKm },
      });
    }
  }
  if (seen === 0) missingOracle = byKey.size;
  return {
    pairs: byKey.size,
    hist,
    symmetryBad,
    symmetryExample,
    nonHubTransfer,
    nonHubExample,
    directEdges,
    directBad,
    directExample,
    priceRoundDiff,
    oraclePathDiff,
    oraclePriceDiff,
    oracleKmDiff,
    oracleExamples,
    missingOracle,
  };
}

function oracleRoute(from: string, to: string): Record<string, unknown> {
  const r = spawnSync('python', [join(here, 'oracle_side.py'), 'route'], {
    input: JSON.stringify({ from, to }),
    encoding: 'utf8',
  });
  if (r.status !== 0) return { ok: false, error: r.stderr || 'oracle failed' };
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function caseVsOracleQuote(c: YamlCase, notes: OracleNote[]): void {
  const input = c.input as { from: string; to: string };
  const exp = c.expect as {
    ok?: boolean;
    code?: string;
    path?: string[];
    totalDistanceKm?: number;
    priceCents?: number;
    display?: { totalDistanceKm?: string; priceUsd?: string };
  };
  const o = oracleRoute(input.from, input.to);
  if (exp.ok !== true || !exp.path) {
    const oracleClass =
      o.ok === true
        ? 'OK'
        : o.error === 'UNKNOWN_CITY'
          ? 'CITY_NOT_FOUND'
          : o.error === 'NO_SERVICE'
            ? 'CITY_NOT_SERVED'
            : o.error === 'SAME_CITY'
              ? 'SAME_CITY'
              : o.error === 'NO_ROUTE'
                ? 'NO_ROUTE'
                : String(o.error);
    if (oracleClass !== exp.code) {
      notes.push({ id: c.id, kind: 'quote-error', caseValue: { ok: exp.ok, code: exp.code }, oracleValue: o });
    }
    return;
  }
  if (o.ok !== true) {
    notes.push({
      id: c.id,
      kind: 'quote',
      caseValue: { ok: true, path: exp.path, priceCents: exp.priceCents },
      oracleValue: o,
    });
    return;
  }
  const oPath = o.path as string[];
  const oCents = o.priceCents as number;
  const oKm = o.totalDistanceKm as number;
  const oDisplay = formatKm(oKm, 'en');
  const diffs: string[] = [];
  if (oPath.join('|') !== exp.path.join('|')) diffs.push('path');
  if (typeof exp.totalDistanceKm === 'number' && !numClose(oKm, exp.totalDistanceKm)) diffs.push('totalDistanceKm');
  if (exp.priceCents !== oCents) diffs.push('priceCents');
  if (exp.display?.totalDistanceKm !== undefined && exp.display.totalDistanceKm !== oDisplay)
    diffs.push('display.totalDistanceKm');
  const priceUsd = exp.priceCents !== undefined ? (exp.priceCents / 100).toFixed(2) : undefined;
  if (
    exp.display?.priceUsd !== undefined &&
    priceUsd !== undefined &&
    exp.display.priceUsd !== (oCents / 100).toFixed(2)
  ) {
    diffs.push('display.priceUsd');
  }
  if (diffs.length > 0) {
    notes.push({
      id: c.id,
      kind: `quote:${diffs.join(',')}`,
      caseValue: {
        path: exp.path,
        totalDistanceKm: exp.totalDistanceKm,
        priceCents: exp.priceCents,
        display: exp.display,
      },
      oracleValue: {
        path: oPath,
        totalDistanceKm: oKm,
        priceCents: oCents,
        displayTotal: oDisplay,
        priceUsd: (oCents / 100).toFixed(2),
      },
    });
  }
}

export async function runDeterministic(): Promise<DeterministicReport> {
  const dbPath = join(root, 'locations.db');
  const core = createFlightCore({ dbPath });
  const names: string[] = [];
  const net = loadNetwork(dbPath, readFileSync(dbPath));
  for (const n of net.nodes) names.push(n.city.name);
  const suites = loadSuites();
  const results: CaseResult[] = [];
  const notes: OracleNote[] = [];
  const nearestPath = join(tmpdir(), 't13b-nearest-oracle.json');
  const dumpPath = join(tmpdir(), 't13b-oracle-routes.tsv');
  const prep = spawnSync('python', [join(here, 'oracle_side.py'), 'nearest', nearestPath], { encoding: 'utf8' });
  if (prep.status !== 0) throw new Error(`oracle nearest failed: ${prep.stderr}`);
  const dump = spawnSync('python', [join(here, 'oracle_side.py'), 'dump', dumpPath], { encoding: 'utf8' });
  if (dump.status !== 0) throw new Error(`oracle dump failed: ${dump.stderr}`);
  const nearestOracle = JSON.parse(readFileSync(nearestPath, 'utf8')) as Record<
    string,
    { nearest: string; rawDistanceKm: number; second: string; secondRawDistanceKm: number; serviced: boolean }
  >;

  for (const suite of suites) {
    for (const c of suite.cases) {
      if (c.fn.startsWith('property.')) continue;
      const result = runCase(core, names, c);
      results.push(result);
      if (c.fn === 'quote') caseVsOracleQuote(c, notes);
      if (c.fn === 'nearestServed') {
        const city = (c.input as { city: string }).city;
        const exp = c.expect as {
          nearestServed: { city: string; distanceKm: string };
          secondNearest?: { city: string; distanceKm: string };
          rawDistanceKm?: number;
        };
        const o = nearestOracle[city];
        if (!o) {
          notes.push({ id: c.id, kind: 'nearest', caseValue: exp.nearestServed, oracleValue: null });
        } else {
          const display = formatKm(o.rawDistanceKm, 'en');
          const secondDisplay = formatKm(o.secondRawDistanceKm, 'en');
          if (o.nearest !== exp.nearestServed.city || display !== exp.nearestServed.distanceKm) {
            notes.push({
              id: c.id,
              kind: 'nearest',
              caseValue: exp.nearestServed,
              oracleValue: { city: o.nearest, distanceKm: display, rawDistanceKm: o.rawDistanceKm },
              implValue: core.nearestServed(city),
            });
          } else if (typeof exp.rawDistanceKm === 'number' && !numClose(exp.rawDistanceKm, o.rawDistanceKm)) {
            notes.push({
              id: c.id,
              kind: 'nearest-raw',
              caseValue: exp.rawDistanceKm,
              oracleValue: o.rawDistanceKm,
            });
          }
          if (
            exp.secondNearest &&
            (exp.secondNearest.city !== o.second || exp.secondNearest.distanceKm !== secondDisplay)
          ) {
            notes.push({
              id: c.id,
              kind: 'second-nearest',
              caseValue: exp.secondNearest,
              oracleValue: { city: o.second, distanceKm: secondDisplay, rawDistanceKm: o.secondRawDistanceKm },
            });
          }
        }
      }
    }
  }

  process.stderr.write('sweep start\n');
  const swept = await sweep(core, names, dumpPath);
  notes.push(...swept.oracleExamples);
  if (swept.oraclePathDiff || swept.oraclePriceDiff || swept.oracleKmDiff) {
    notes.push({
      id: 'sweep',
      kind: 'route-sweep-counts',
      caseValue: { pairs: swept.pairs },
      oracleValue: {
        pathDiff: swept.oraclePathDiff,
        priceDiff: swept.oraclePriceDiff,
        kmDiff: swept.oracleKmDiff,
        missing: swept.missingOracle,
      },
    });
  }

  const propExpect = new Map<string, YamlCase>();
  for (const suite of suites) for (const c of suite.cases) if (c.fn.startsWith('property.')) propExpect.set(c.id, c);
  const propResults: CaseResult[] = [];
  const histWant = (propExpect.get('det-prop-004')?.expect ?? {}) as Record<string, number>;
  const histBad = Object.entries(histWant).filter(([k, v]) => swept.hist[k] !== v);
  propResults.push(
    histBad.length === 0
      ? { id: 'det-prop-004', fn: 'property.legHistogram', pass: true }
      : {
          id: 'det-prop-004',
          fn: 'property.legHistogram',
          pass: false,
          detail: histBad.map(([k, v]) => `${k}: impl=${swept.hist[k] ?? 0} case=${v}`).join('; '),
        },
  );
  propResults.push(
    swept.symmetryBad === 0
      ? { id: 'det-prop-001', fn: 'property.symmetry', pass: true }
      : {
          id: 'det-prop-001',
          fn: 'property.symmetry',
          pass: false,
          detail: `${swept.symmetryBad} ${swept.symmetryExample ?? ''}`,
        },
  );
  propResults.push(
    swept.directBad === 0
      ? { id: 'det-prop-002', fn: 'property.directIsOneLeg', pass: true }
      : {
          id: 'det-prop-002',
          fn: 'property.directIsOneLeg',
          pass: false,
          detail: `${swept.directBad}/${swept.directEdges} ${swept.directExample ?? ''}`,
        },
  );
  propResults.push(
    swept.nonHubTransfer === 0
      ? { id: 'det-prop-003', fn: 'property.intermediatesAreHubs', pass: true }
      : {
          id: 'det-prop-003',
          fn: 'property.intermediatesAreHubs',
          pass: false,
          detail: `${swept.nonHubTransfer} ${swept.nonHubExample ?? ''}`,
        },
  );
  const tieNote =
    '未重跑 gen 脚本的全量简单路径枚举。全量有序对上，flight-core 与 oracle 的路径/价格若一致，则两边选出的最优相同；这不能单独证明「次优距离差 < 1e-6」的条数为 0。';
  propResults.push({
    id: 'det-prop-005',
    fn: 'property.noExactTies',
    pass: swept.oraclePathDiff === 0,
    detail: tieNote,
  });
  const wantPrice = 7932;
  propResults.push(
    swept.priceRoundDiff === wantPrice
      ? { id: 'det-prop-006', fn: 'property.priceFromRawDistance', pass: true }
      : {
          id: 'det-prop-006',
          fn: 'property.priceFromRawDistance',
          pass: false,
          detail: `impl unordered pairs where round(raw*13) != round(round2(raw)*13): ${swept.priceRoundDiff}; case text says ${wantPrice}`,
        },
  );
  results.push(...propResults);
  rmSync(nearestPath, { force: true });
  rmSync(dumpPath, { force: true });
  const failed = results.filter((r) => !r.pass);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed,
    oracleDisagreements: notes,
    property: {
      pairs: swept.pairs,
      hist: swept.hist,
      directEdges: swept.directEdges,
      priceRoundDiff: swept.priceRoundDiff,
      oraclePathDiff: swept.oraclePathDiff,
      oraclePriceDiff: swept.oraclePriceDiff,
      oracleKmDiff: swept.oracleKmDiff,
      tieCheck: tieNote,
    },
  };
}
