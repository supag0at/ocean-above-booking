// T12b: one repeatable backend integration. Starts t12b-postgres and t12b-redis, applies infra/db,
// then booking, hands, gateway and harness. The model is a local OpenAI-compatible stand-in.
// Exits 0 only when all five assertions pass. Always removes the two t12b- containers.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFlightCore } from '../../packages/flight-core/src/index.ts';
import { buildProfile } from '../../packages/memory/src/profile.ts';
import { createPgPool, type Pool } from '../../packages/platform/src/pg/index.ts';
import { createRedis } from '../../packages/platform/src/redis/index.ts';
import { gatewayAclRule } from '../../services/gateway/src/redis-acl.ts';
import { listMemories, listMemoryDeletions, listTicketRows } from '../../services/hands/src/db.ts';
import { FakeLlmServer, type ChatRequest, type ScriptedReply } from '../../services/harness/test/fakes/llm-server.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const INFRA_DB = join(ROOT, 'infra', 'db');
const LOCATIONS_DB = join(ROOT, 'locations.db');

const ORIGIN = 'http://127.0.0.1:5173';
const PUBLIC = 'http://127.0.0.1:8080';
const GATEWAY_INTERNAL = 'http://127.0.0.1:8081';
const HANDS_URL = 'http://127.0.0.1:8082';
const BOOKING_URL = 'http://127.0.0.1:8083';
/** Dedicated host ports. A port cannot carry the literal prefix "t12b"; the containers are named t12b-*. */
const PG_HOST_PORT = 45432;
const REDIS_HOST_PORT = 46379;
const PG_CONTAINER = 't12b-postgres';
const REDIS_CONTAINER = 't12b-redis';
const FLIGHT_TEXT = '从上海飞圣保罗';
const PREFERENCE_TEXT = '请记住我的家乡是上海';
const QUOTE_ID_RE = /q_[0-9A-HJKMNP-TV-Z]{26}/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Proc {
  readonly name: string;
  readonly child: ChildProcess;
  readonly lines: string[];
}

interface ApiEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

const procs: Proc[] = [];
const secretValues: string[] = [];
let secretsDir: string | undefined;
let ownerPool: Pool | undefined;
let handsPool: Pool | undefined;
let fake: FakeLlmServer | undefined;

function scrub(text: string): string {
  let out = text;
  for (const v of secretValues) {
    if (v.length < 8) continue;
    out = out.split(v).join('[redacted]');
  }
  return out;
}

function remember(value: string): string {
  secretValues.push(value);
  return value;
}

function docker(args: string[], allowFail = false): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (r.error) {
    if (allowFail) return { status: 1, stdout: '', stderr: r.error.message };
    throw new Error(`无法执行 docker（${r.error.message}）`);
  }
  const status = r.status ?? 1;
  if (status !== 0 && !allowFail) {
    const detail = scrub(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)
      .trim()
      .slice(-2000);
    throw new Error(`docker ${args[0] ?? ''} 失败（${status}）：${detail}`);
  }
  return { status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ensureImage(image: string): void {
  if (docker(['image', 'inspect', image], true).status === 0) return;
  console.log(`本地没有镜像 ${image}，正在拉取`);
  docker(['pull', image]);
}

function removeOwnContainers(): void {
  docker(['rm', '-f', PG_CONTAINER], true);
  docker(['rm', '-f', REDIS_CONTAINER], true);
}

function leftoverContainers(): string[] {
  const r = docker(['ps', '-a', '--format', '{{.Names}}'], true);
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((n) => n.startsWith('t12b-'));
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRec(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function lastUserIndex(body: ChatRequest): number {
  let idx = -1;
  body.messages.forEach((m, i) => {
    if (m.role === 'user') idx = i;
  });
  return idx;
}

function spawnNode(name: string, script: string, env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const proc: Proc = { name, child, lines: [] };
  const onData = (buf: Buffer): void => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (line === '') continue;
      proc.lines.push(scrub(line));
      if (proc.lines.length > 200) proc.lines.shift();
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  procs.push(proc);
  return proc;
}

function assertAlive(p: Proc): void {
  if (p.child.exitCode !== null || p.child.signalCode !== null) {
    throw new Error(
      `${p.name} 提前退出（${p.child.exitCode ?? p.child.signalCode}）\n${p.lines.slice(-40).join('\n')}`,
    );
  }
}

function tailOf(list: readonly Proc[]): string {
  return list.map((p) => `--- ${p.name} ---\n${p.lines.slice(-40).join('\n')}`).join('\n');
}

async function stopProc(p: Proc): Promise<void> {
  if (p.child.exitCode !== null || p.child.signalCode !== null) return;
  p.child.kill();
  await new Promise<void>((resolvePromise) => {
    const t = setTimeout(() => {
      if (p.child.exitCode === null) p.child.kill('SIGKILL');
      resolvePromise();
    }, 3000);
    p.child.once('exit', () => {
      clearTimeout(t);
      resolvePromise();
    });
  });
}

async function waitHttp(url: string, watch: readonly Proc[]): Promise<void> {
  const end = Date.now() + 30_000;
  let last = '';
  while (Date.now() < end) {
    for (const p of watch) assertAlive(p);
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时（${scrub(last)}）\n${tailOf(watch)}`);
}

async function waitLog(p: Proc, needle: string): Promise<void> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    assertAlive(p);
    if (p.lines.some((l) => l.includes(needle))) return;
    await sleep(200);
  }
  throw new Error(`${p.name} 没有出现「${needle}」\n${p.lines.slice(-40).join('\n')}`);
}

function containerLogs(name: string): string {
  const r = docker(['logs', name], true);
  return scrub(`${r.stdout}\n${r.stderr}`);
}

/** Docker Desktop parses `C:\...` as a drive-letter colon. Mounts use forward slashes. */
function mount(src: string, dest: string): string {
  return `${src.replace(/\\/g, '/')}:${dest}:ro`;
}

async function waitPostgres(password: string): Promise<Pool> {
  const end = Date.now() + 180_000;
  let sawInit = false;
  while (Date.now() < end) {
    const text = containerLogs(PG_CONTAINER);
    if (/00-roles\.sh: missing|psql: error|ERROR:/.test(text)) {
      throw new Error(`postgres 初始化失败\n${text.slice(-3000)}`);
    }
    if (text.includes('PostgreSQL init process complete')) sawInit = true;
    if (sawInit) {
      const pool = createPgPool({
        host: '127.0.0.1',
        port: PG_HOST_PORT,
        database: 'app',
        user: 'fb_owner',
        secrets: { get: () => password },
        max: 2,
        connectionTimeoutMs: 1000,
        applicationName: 't12b-owner',
      });
      try {
        await pool.query('SELECT 1 FROM app.schema_migrations LIMIT 1');
        return pool;
      } catch {
        await pool.end().catch(() => undefined);
      }
    }
    await sleep(1000);
  }
  throw new Error(`postgres 没有在 180s 内就绪\n${containerLogs(PG_CONTAINER).slice(-3000)}`);
}

async function waitRedis(user: string, password: string): Promise<void> {
  const end = Date.now() + 30_000;
  let last = '';
  while (Date.now() < end) {
    const redis = createRedis({
      host: '127.0.0.1',
      port: REDIS_HOST_PORT,
      username: user,
      secrets: { get: () => password },
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeoutMs: 1000,
      connectionName: 't12b-probe',
    });
    try {
      await redis.connect();
      const pong = await redis.ping();
      redis.disconnect();
      if (pong === 'PONG') return;
      last = String(pong);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      redis.disconnect();
    }
    await sleep(400);
  }
  const logs = containerLogs(REDIS_CONTAINER);
  throw new Error(`redis 没有在 30s 内就绪（${scrub(last)}）\n${logs.slice(-2000)}`);
}

function exactCity(original: string, candidates: readonly string[]): string {
  const core = flightCore();
  const r = core.resolveCity({ original, candidates: [...candidates] });
  const only = r.matches[0];
  if (r.status !== 'exact' || r.matches.length !== 1 || only === undefined) {
    const names = r.matches.map((m) => m.city).join(', ');
    throw new Error(`locations.db 解析「${original}」得到 ${r.status}（${names}），不是唯一规范名`);
  }
  if (core.getCity(only.city)?.name !== only.city) {
    throw new Error(`解析结果 ${only.city} 不在库的规范名索引里`);
  }
  if (!only.served) throw new Error(`规范名 ${only.city} 在库里未通航，报价场景无法继续`);
  return only.city;
}

let coreCache: ReturnType<typeof createFlightCore> | undefined;
function flightCore(): ReturnType<typeof createFlightCore> {
  coreCache ??= createFlightCore({ dbPath: LOCATIONS_DB });
  return coreCache;
}

function scriptedModel(fromCity: string, toCity: string): (body: ChatRequest) => ScriptedReply {
  return (body) => {
    const idx = lastUserIndex(body);
    const last = idx < 0 ? '' : contentText(body.messages[idx]?.content);
    const after = JSON.stringify(body.messages.slice(idx + 1));
    if (last.includes('请记住')) {
      if (!after.includes('Saved:')) {
        return { toolCalls: [{ name: 'save_preference', args: { key: 'home_city', value: fromCity } }] };
      }
      return { text: '已记下你的家乡。' };
    }
    if (/ERROR |not_found:|ambiguous:|suggest:/.test(after) && !after.includes('Quote ')) {
      return { text: '城市没有解析成功。' };
    }
    if (!after.includes('exact:')) {
      return {
        text: '我先查城市。',
        toolCalls: [
          { name: 'resolve_city', args: { original: '上海', candidates: ['Shanghai'] } },
          { name: 'resolve_city', args: { original: '圣保罗', candidates: ['Sao Paulo'] } },
        ],
      };
    }
    if (!after.includes('Quote ')) {
      return { toolCalls: [{ name: 'quote_route', args: { from: fromCity, to: toCity } }] };
    }
    if (!after.includes('Booking card shown')) {
      const quoteId = QUOTE_ID_RE.exec(after)?.[0];
      if (quoteId === undefined) return { text: '没有看到报价编号。' };
      return { toolCalls: [{ name: 'offer_booking', args: { quoteId } }] };
    }
    return { text: '报价已生成，请看报价卡。' };
  };
}

class PublicApi {
  private sid = '';
  private csrf = '';
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private headers(kind: 'login' | 'json' | 'bodyless' | 'get'): Record<string, string> {
    const h: Record<string, string> = {};
    if (kind !== 'get') h.origin = ORIGIN;
    if (this.sid !== '') h.cookie = `fb_sid=${this.sid}; fb_csrf=${this.csrf}`;
    if (kind === 'json' || kind === 'bodyless') h['x-csrf-token'] = this.csrf;
    if (kind === 'login' || kind === 'json') h['content-type'] = 'application/json';
    return h;
  }

  async send(
    method: string,
    path: string,
    kind: 'login' | 'json' | 'bodyless' | 'get',
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(kind),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    if (text === '') json = undefined;
    else {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = text.slice(0, 300);
      }
    }
    if (kind === 'login' && res.status === 200) {
      const lines = res.headers.getSetCookie();
      const sid = cookieValue(lines, 'fb_sid');
      const csrf = cookieValue(lines, 'fb_csrf');
      if (sid === undefined || csrf === undefined) throw new Error('登录响应没有 fb_sid / fb_csrf');
      this.sid = sid;
      this.csrf = csrf;
    }
    return { status: res.status, json };
  }

  hasCookie(): boolean {
    return this.sid !== '' && this.csrf !== '';
  }
}

function cookieValue(lines: readonly string[], name: string): string | undefined {
  for (const line of lines) {
    const part = line.split(';')[0] ?? '';
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function errorCode(body: unknown): string {
  if (!isRec(body) || !isRec(body.error)) return '';
  return typeof body.error.code === 'string' ? body.error.code : '';
}

async function allEvents(api: PublicApi, sessionId: string): Promise<ApiEvent[]> {
  const out: ApiEvent[] = [];
  let after = 0;
  for (;;) {
    const res = await api.send('GET', `/api/v1/sessions/${sessionId}/events?afterSeq=${after}&limit=200`, 'get');
    if (res.status !== 200 || !isRec(res.json) || !Array.isArray(res.json.events)) {
      throw new Error(`读取事件失败 HTTP ${res.status} ${errorCode(res.json)}`);
    }
    const page: ApiEvent[] = [];
    for (const raw of res.json.events) {
      if (!isRec(raw) || typeof raw.seq !== 'number' || typeof raw.type !== 'string' || !isRec(raw.payload)) continue;
      page.push({ seq: raw.seq, type: raw.type, payload: raw.payload });
    }
    out.push(...page);
    if (res.json.hasMore !== true || page.length === 0) return out;
    after = page[page.length - 1]?.seq ?? after;
  }
}

async function sessionStatus(api: PublicApi, sessionId: string): Promise<string> {
  const res = await api.send('GET', `/api/v1/sessions/${sessionId}`, 'get');
  if (res.status !== 200 || !isRec(res.json) || !isRec(res.json.session)) {
    throw new Error(`读取会话失败 HTTP ${res.status} ${errorCode(res.json)}`);
  }
  return str(res.json.session.status);
}

function toolCalls(events: readonly ApiEvent[], name: string): ApiEvent[] {
  return events.filter((e) => e.type === 'agent.message' && e.payload.toolName === name);
}

async function waitSession(
  api: PublicApi,
  sessionId: string,
  harness: Proc,
  pred: (events: readonly ApiEvent[], status: string) => boolean,
): Promise<{ events: ApiEvent[]; status: string }> {
  const end = Date.now() + 90_000;
  let last = '';
  while (Date.now() < end) {
    assertAlive(harness);
    const status = await sessionStatus(api, sessionId);
    const events = await allEvents(api, sessionId);
    const types = events.map((e) => e.type).join(',');
    last = `status=${status} ${types}`;
    if (status === 'error') {
      throw new Error(`会话进入 error（${types}）\n${harness.lines.slice(-50).join('\n')}`);
    }
    if (pred(events, status)) return { events, status };
    await sleep(400);
  }
  throw new Error(`等待会话超时（${last}）\n${harness.lines.slice(-50).join('\n')}`);
}

function writeSecrets(dir: string): {
  ownerPw: string;
  handsPw: string;
  redisGatewayPw: string;
  publicKeyPath: string;
} {
  const pw = (name: string): string => {
    const v = remember(randomBytes(18).toString('hex'));
    writeFileSync(join(dir, name), `${v}\n`);
    return v;
  };
  pw('pg_superuser_password');
  const ownerPw = pw('pg_owner_password');
  pw('pg_gateway_password');
  const handsPw = pw('pg_hands_password');
  pw('pg_booking_password');
  const redisGatewayPw = pw('redis_gateway_password');
  const redisHarnessPw = pw('redis_harness_password');
  pw('harness_service_token');
  pw('booking_service_token');
  pw('cookie_secret');
  pw('deepseek_api_key');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  remember(privatePem);
  remember(publicPem);
  writeFileSync(join(dir, 'hands_token_signing_key'), privatePem);
  const publicKeyPath = join(dir, 'hands_token_public_key.pem');
  writeFileSync(publicKeyPath, publicPem);
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  writeFileSync(
    join(dir, 'users.acl'),
    [
      'user default off',
      gatewayAclRule(sha(redisGatewayPw)),
      // A-01 §7.2 harness categories, plus +info (BullMQ runs INFO on connect; same line as the gateway tests).
      `user harness on #${sha(redisHarnessPw)} ~bull:harness-wake:* ~lease:* &sse:* +@read +@write +@pubsub +@scripting +@transaction +@connection +@blocking -@dangerous +info`,
      '',
    ].join('\n'),
  );
  return { ownerPw, handsPw, redisGatewayPw, publicKeyPath };
}

async function cleanup(): Promise<void> {
  for (const p of [...procs].reverse()) await stopProc(p).catch(() => undefined);
  await handsPool?.end().catch(() => undefined);
  await ownerPool?.end().catch(() => undefined);
  await fake?.stop().catch(() => undefined);
  removeOwnContainers();
  if (secretsDir !== undefined) rmSync(secretsDir, { recursive: true, force: true });
}

async function run(): Promise<void> {
  const fromCity = exactCity('上海', ['Shanghai']);
  const toCity = exactCity('圣保罗', ['Sao Paulo']);
  const core = flightCore();
  console.log(`规范名：上海 -> ${fromCity}，圣保罗 -> ${toCity}，dataSha256=${core.dataSha256}`);

  ensureImage('postgres:16');
  ensureImage('redis:7');
  removeOwnContainers();

  secretsDir = mkdtempSync(join(tmpdir(), 't12b-secrets-'));
  const secrets = writeSecrets(secretsDir);
  const dir = secretsDir;

  docker([
    'run',
    '-d',
    '--name',
    PG_CONTAINER,
    '--label',
    'fb.task=t12b',
    '-e',
    'POSTGRES_DB=app',
    '-e',
    'POSTGRES_PASSWORD_FILE=/run/secrets/pg_superuser_password',
    '-e',
    'INFRA_DB_DIR=/infra-db',
    '-p',
    `127.0.0.1:${PG_HOST_PORT}:5432`,
    '-v',
    mount(dir, '/run/secrets'),
    '-v',
    mount(INFRA_DB, '/infra-db'),
    '-v',
    mount(join(INFRA_DB, 'init', '00-roles.sh'), '/docker-entrypoint-initdb.d/00-roles.sh'),
    'postgres:16',
  ]);
  docker([
    'run',
    '-d',
    '--name',
    REDIS_CONTAINER,
    '--label',
    'fb.task=t12b',
    '-p',
    `127.0.0.1:${REDIS_HOST_PORT}:6379`,
    '-v',
    mount(dir, '/acl'),
    'redis:7',
    'sh',
    '-c',
    'cp /acl/users.acl /tmp/users.acl && chmod 600 /tmp/users.acl && exec redis-server --aclfile /tmp/users.acl --save "" --appendonly no',
  ]);

  ownerPool = await waitPostgres(secrets.ownerPw);
  await waitRedis('gateway', secrets.redisGatewayPw);

  fake = new FakeLlmServer();
  fake.script = scriptedModel(fromCity, toCity);
  await fake.start();
  const llmBase = fake.baseUrl;

  const pgBase = {
    PG_HOST: '127.0.0.1',
    PG_PORT: String(PG_HOST_PORT),
    PG_DATABASE: 'app',
    SECRETS_DIR: dir,
    LOG_LEVEL: 'info',
  };
  const peers = '127.0.0.1/32';
  const booking = spawnNode('booking', join('services', 'booking', 'src', 'main.ts'), {
    ...process.env,
    ...pgBase,
    BOOKING_BIND: '127.0.0.1:8083',
    BOOKING_ALLOWED_PEERS: peers,
    PG_USER: 'fb_booking',
  });
  const hands = spawnNode('hands', join('services', 'hands', 'src', 'run.ts'), {
    ...process.env,
    ...pgBase,
    HANDS_BIND: '127.0.0.1:8082',
    HANDS_ALLOWED_PEERS: peers,
    PG_USER: 'fb_hands',
    LOCATIONS_DB_PATH: LOCATIONS_DB,
    HANDS_VERIFY_KEY_PATHS: secrets.publicKeyPath,
  });
  const gateway = spawnNode('gateway', join('services', 'gateway', 'src', 'main.ts'), {
    ...process.env,
    ...pgBase,
    PUBLIC_BIND: '127.0.0.1:8080',
    PUBLIC_ALLOWED_PEERS: peers,
    INTERNAL_BIND: '127.0.0.1:8081',
    INTERNAL_ALLOWED_PEERS: peers,
    PUBLIC_ORIGIN: ORIGIN,
    COOKIE_SECURE: '0',
    PG_USER: 'fb_gateway',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(REDIS_HOST_PORT),
    REDIS_USER: 'gateway',
    BOOKING_URL,
    AGENT_DELTA_MODE: 'stream',
  });
  await waitHttp(`${BOOKING_URL}/readyz`, [booking]);
  await waitHttp(`${HANDS_URL}/readyz`, [hands]);
  await waitHttp(`${PUBLIC}/readyz`, [gateway]);
  await waitHttp(`${GATEWAY_INTERNAL}/readyz`, [gateway]);

  const harness = spawnNode('harness', join('services', 'harness', 'src', 'main.ts'), {
    ...process.env,
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(REDIS_HOST_PORT),
    REDIS_USER: 'harness',
    SESSION_API_URL: GATEWAY_INTERNAL,
    HANDS_URL,
    SECRETS_DIR: dir,
    HARNESS_CONCURRENCY: '1',
    LOG_LEVEL: 'info',
    LLM_BASE_URL: llmBase,
  });
  await waitLog(harness, 'harness worker started');

  handsPool = createPgPool({
    host: '127.0.0.1',
    port: PG_HOST_PORT,
    database: 'app',
    user: 'fb_hands',
    secrets: { get: () => secrets.handsPw },
    max: 2,
    applicationName: 't12b-hands-read',
  });

  const api = new PublicApi(PUBLIC);

  const login = await api.send('POST', '/api/v1/auth/login', 'login', { username: 't12b' });
  if (login.status !== 200 || !isRec(login.json) || !isRec(login.json.user) || !api.hasCookie()) {
    throw new Error(`登录失败 HTTP ${login.status} ${errorCode(login.json)}`);
  }
  const userId = str(login.json.user.id);
  if (userId === '') throw new Error('登录响应没有 user.id');
  console.log(`[1] 只填用户名登录成功，已拿到 cookie（fb_sid、fb_csrf），user=${userId}`);

  const created = await api.send('POST', '/api/v1/sessions', 'json', { locale: 'zh' });
  if (created.status !== 201 || !isRec(created.json) || !isRec(created.json.session)) {
    throw new Error(`建会话失败 HTTP ${created.status} ${errorCode(created.json)}`);
  }
  const sessionId = str(created.json.session.id);
  if (sessionId === '') throw new Error('建会话响应没有 session.id');
  const posted = await api.send('POST', `/api/v1/sessions/${sessionId}/messages`, 'json', {
    text: FLIGHT_TEXT,
    clientMessageId: randomUUID(),
  });
  if (posted.status !== 202) throw new Error(`发送消息失败 HTTP ${posted.status} ${errorCode(posted.json)}`);
  console.log(`[2] 已建会话 ${sessionId}，已发送「${FLIGHT_TEXT}」（HTTP 202）`);

  const flight = await waitSession(api, sessionId, harness, (events, status) => {
    return status === 'idle' && events.some((e) => e.type === 'quote.offered');
  });
  if (!flight.events.some((e) => e.type === 'agent.run_started')) {
    throw new Error('没有 agent.run_started，harness 没有被门铃唤醒');
  }
  for (const name of ['resolve_city', 'quote_route', 'offer_booking'] as const) {
    const calls = toolCalls(flight.events, name);
    if (calls.length === 0 || calls.some((c) => c.payload.isError === true)) {
      throw new Error(`${name} 没有成功执行（${calls.length} 次）`);
    }
  }
  if (toolCalls(flight.events, 'resolve_city').length < 2) throw new Error('resolve_city 少于 2 次');
  const offered = flight.events.find((e) => e.type === 'quote.offered');
  const quoteId = offered === undefined ? '' : str(offered.payload.quoteId);
  if (!QUOTE_ID_RE.test(quoteId)) throw new Error(`quote.offered 没有合法 quoteId（${quoteId}）`);
  const quoteRes = await api.send('GET', `/api/v1/quotes/${quoteId}`, 'get');
  if (
    quoteRes.status !== 200 ||
    !isRec(quoteRes.json) ||
    !isRec(quoteRes.json.quote) ||
    !isRec(quoteRes.json.quote.quote)
  ) {
    throw new Error(`读取报价失败 HTTP ${quoteRes.status} ${errorCode(quoteRes.json)}`);
  }
  const quote = quoteRes.json.quote.quote;
  const qFrom = str(quote.from);
  const qTo = str(quote.to);
  if (qFrom !== fromCity || qTo !== toCity) {
    throw new Error(`报价城市名 ${qFrom} -> ${qTo}，库里的规范名是 ${fromCity} -> ${toCity}`);
  }
  if (core.getCity(qFrom)?.name !== qFrom || core.getCity(qTo)?.name !== qTo) {
    throw new Error('报价城市名不是 getCity 返回的规范名');
  }
  if (str(quote.dataSha256) !== core.dataSha256) {
    throw new Error(`报价 dataSha256 与 locations.db 不一致`);
  }
  console.log(
    `[3] harness 已唤醒；hands 报价 ${quoteId} 城市名 ${qFrom} -> ${qTo}（与 locations.db 规范名一致，dataSha256 一致）`,
  );

  const confirm1 = await api.send('POST', `/api/v1/quotes/${quoteId}/confirm`, 'bodyless');
  if (confirm1.status !== 201 || !isRec(confirm1.json) || !isRec(confirm1.json.ticket)) {
    throw new Error(`首次确认失败 HTTP ${confirm1.status} ${errorCode(confirm1.json)}`);
  }
  const ticketId = str(confirm1.json.ticket.ticketId);
  const ticketNo = str(confirm1.json.ticket.ticketNo);
  if (ticketId === '' || str(confirm1.json.ticket.quoteId) !== quoteId) throw new Error('首次确认的票与报价不匹配');
  const confirm2 = await api.send('POST', `/api/v1/quotes/${quoteId}/confirm`, 'bodyless');
  if (
    confirm2.status !== 200 ||
    !isRec(confirm2.json) ||
    confirm2.json.alreadyBooked !== true ||
    !isRec(confirm2.json.ticket) ||
    str(confirm2.json.ticket.ticketId) !== ticketId
  ) {
    throw new Error(`再次确认没有返回同一张票的 alreadyBooked HTTP ${confirm2.status} ${errorCode(confirm2.json)}`);
  }
  const tickets = await api.send('GET', '/api/v1/tickets', 'get');
  if (!isRec(tickets.json) || !Array.isArray(tickets.json.items) || tickets.json.items.length !== 1) {
    throw new Error(`机票列表不是 1 张（HTTP ${tickets.status}）`);
  }
  const only = tickets.json.items[0];
  if (!isRec(only) || str(only.ticketId) !== ticketId || str(only.quoteId) !== quoteId) {
    throw new Error('机票列表里的那张票不是这次确认的票');
  }
  const count = await handsPool.query<{ n: number }>('SELECT count(*)::int AS n FROM app.tickets WHERE user_id = $1', [
    userId,
  ]);
  if (count.rows[0]?.n !== 1) throw new Error(`app.tickets 行数是 ${count.rows[0]?.n ?? '空'}，不是 1`);
  console.log(`[4] 确认 HTTP 201 出票 ${ticketNo}；再次确认 HTTP 200 alreadyBooked=true；机票仍为 1 张`);

  const prefMsg = await api.send('POST', `/api/v1/sessions/${sessionId}/messages`, 'json', {
    text: PREFERENCE_TEXT,
    clientMessageId: randomUUID(),
  });
  if (prefMsg.status !== 202) throw new Error(`发送偏好消息失败 HTTP ${prefMsg.status} ${errorCode(prefMsg.json)}`);
  const pref = await waitSession(api, sessionId, harness, (events, status) => {
    const saves = toolCalls(events, 'save_preference');
    return status === 'idle' && saves.length > 0 && saves.every((c) => c.payload.isError !== true);
  });
  if (toolCalls(pref.events, 'save_preference').some((c) => c.payload.isError === true)) {
    throw new Error('save_preference 返回错误');
  }
  const memories = await listMemories(handsPool, userId);
  const deletions = await listMemoryDeletions(handsPool, userId);
  const ticketRows = await listTicketRows(handsPool, userId);
  const snap = buildProfile({
    userId,
    memories,
    deletions,
    tickets: ticketRows,
    isCityServed: (cityName) => core.isServed(cityName),
  });
  if (snap.homeCity?.city !== fromCity || snap.homeCity.served !== core.isServed(fromCity)) {
    throw new Error(
      `buildProfile 读回 homeCity=${snap.homeCity?.city ?? '无'}/served=${String(snap.homeCity?.served)}，期望 ${fromCity}/${String(core.isServed(fromCity))}`,
    );
  }
  if (snap.ticketCount !== 1) throw new Error(`buildProfile.ticketCount=${snap.ticketCount}，期望 1`);
  console.log(
    `[5] save_preference 已写入 home_city=${fromCity}；buildProfile 读回 homeCity.city=${snap.homeCity.city} served=${String(snap.homeCity.served)} ticketCount=${snap.ticketCount}`,
  );
  console.log('t12b integration ok');
}

async function main(): Promise<void> {
  let code = 0;
  try {
    await run();
  } catch (err) {
    code = 1;
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(scrub(text));
  } finally {
    await cleanup();
  }
  const left = leftoverContainers();
  if (left.length > 0) {
    console.error(`仍有 t12b- 容器：${left.join(', ')}`);
    code = 1;
  } else {
    console.log('没有遗留 t12b- 容器');
  }
  process.exit(code);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
