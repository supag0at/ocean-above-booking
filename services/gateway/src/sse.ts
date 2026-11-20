// SSE fan-out (A-01 §4.4, §7.1, S-4; CONTRACT M-4, M-10, M-17).
// One Redis subscriber per gateway process: PSUBSCRIBE sse:session:* and SUBSCRIBE sse:logout.
// - {kind:'evt', seq}: only a signal. The connection re-reads rows `seq > lastSent` from Postgres and sends them
//   through toPublicEvent; nothing from the notification itself is forwarded. Reading a range (not one seq) also
//   fills any gap and de-duplicates by seq.
// - {kind:'eph', event}: schema check, channel sid == event.sessionId, fence >= GET lease:fence:{sid} (1 s cache),
//   size <= 4 KB, AGENT_DELTA_MODE; then forwarded as PublicEphemeral (no fence). Anything else is dropped + warn.
// - {kind:'status', status}: forwarded as an `event: status` frame.
// Race between replay and live: the connection registers (so it buffers signals) BEFORE it reads the backlog.
import type { ServerResponse } from 'node:http';
import { EphemeralEnvelope } from '@fb/contracts/server';
import { SSE_EVENT_NAMES, SSE_HEARTBEAT_MS, SSE_RETRY_MS, type SessionStatus } from '@fb/contracts/web';
import type { Logger } from '@fb/platform/log';
import type { Redis } from '@fb/platform/redis';
import { q, type Pool } from './db.ts';
import { SSE_LOGOUT_CHANNEL } from './doorbell.ts';
import { fenceKey } from './fence.ts';
import { check } from './validate.ts';
import { EVENT_COLUMNS, eventRowFromDb, toPublicEphemeral, toPublicEvent } from './views.ts';

export const MAX_EPHEMERAL_BYTES = 4096;
const PAGE = 200;
const STATUSES = new Set(['idle', 'queued', 'running', 'error']);

interface Conn {
  readonly sessionId: string;
  readonly authKey: string;
  readonly res: ServerResponse;
  lastSent: number;
  pumping: boolean;
  again: boolean;
  ready: boolean;
  closed: boolean;
  heartbeat?: NodeJS.Timeout;
}

export interface SseHubOptions {
  readonly pool: Pool;
  /** commands (GET lease:fence:*, PUBLISH sse:logout) */
  readonly redis: Redis;
  /** a dedicated connection that this hub puts into subscriber mode */
  readonly subscriber: Redis;
  readonly log: Logger;
  readonly agentDeltaMode: 'stream' | 'off';
  readonly heartbeatMs?: number;
  readonly fenceCacheMs?: number;
}

export class SseHub {
  private readonly bySession = new Map<string, Set<Conn>>();
  private readonly byAuth = new Map<string, Set<Conn>>();
  private readonly fenceCache = new Map<string, { value: number; at: number }>();
  private readonly o: SseHubOptions;
  /** counters for tests / logs */
  readonly dropped = { schema: 0, session: 0, fence: 0, size: 0, mode: 0, malformed: 0 };

  constructor(o: SseHubOptions) {
    this.o = o;
  }

  async start(): Promise<void> {
    const sub = this.o.subscriber;
    // Redis 7 ACL matches PSUBSCRIBE patterns literally against the channel rules, so the pattern must be exactly
    // the ACL's `&sse:*` (A-01 §7.2); sse:session:{sid} and sse:logout are told apart here.
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (channel === SSE_LOGOUT_CHANNEL) this.onLogout(message);
      else if (channel.startsWith('sse:session:')) this.onSessionMessage(channel, message);
    });
    await sub.psubscribe('sse:*');
  }

  async stop(): Promise<void> {
    for (const set of this.bySession.values()) for (const c of set) this.close(c);
    try {
      await this.o.subscriber.punsubscribe();
    } catch {
      /* already gone */
    }
  }

  connectionCount(): number {
    let n = 0;
    for (const s of this.bySession.values()) n += s.size;
    return n;
  }

  /** Takes over `res` (headers not yet written). Resolves once the backlog has been sent. */
  async open(args: {
    res: ServerResponse;
    sessionId: string;
    authKey: string;
    afterSeq: number;
    traceId: string;
    status: SessionStatus;
  }): Promise<void> {
    const { res } = args;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-trace-id': args.traceId,
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    const conn: Conn = {
      sessionId: args.sessionId,
      authKey: args.authKey,
      res,
      lastSent: args.afterSeq,
      pumping: false,
      again: false,
      ready: false,
      closed: false,
    };
    // register first (signals arriving during the backlog read set `again`), then read the database
    add(this.bySession, conn.sessionId, conn);
    add(this.byAuth, conn.authKey, conn);
    res.on('close', () => this.close(conn));
    conn.heartbeat = setInterval(() => this.write(conn, ': ping\n\n'), this.o.heartbeatMs ?? SSE_HEARTBEAT_MS);
    conn.heartbeat.unref();
    await this.pump(conn);
    this.write(conn, frame(SSE_EVENT_NAMES.status, { status: args.status }));
    conn.ready = true;
  }

  /** Logout (S-4): close every SSE connection of that login, here and (via sse:logout) on other replicas. */
  async logout(authKey: string): Promise<void> {
    this.closeAuth(authKey);
    try {
      await this.o.redis.publish(SSE_LOGOUT_CHANNEL, JSON.stringify({ key: authKey }));
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, 'sse logout broadcast failed');
    }
  }

  private onLogout(message: string): void {
    try {
      const m = JSON.parse(message) as { key?: unknown };
      if (typeof m.key === 'string') this.closeAuth(m.key);
    } catch {
      /* ignore */
    }
  }

  private closeAuth(authKey: string): void {
    for (const c of [...(this.byAuth.get(authKey) ?? [])]) this.close(c);
  }

  private close(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    if (c.heartbeat) clearInterval(c.heartbeat);
    remove(this.bySession, c.sessionId, c);
    remove(this.byAuth, c.authKey, c);
    if (!c.res.writableEnded) c.res.end();
  }

  private write(c: Conn, chunk: string): void {
    if (!c.closed && !c.res.writableEnded) c.res.write(chunk);
  }

  /** Send every durable event after lastSent; coalesces concurrent signals. */
  private async pump(c: Conn): Promise<void> {
    if (c.pumping) {
      c.again = true;
      return;
    }
    c.pumping = true;
    try {
      do {
        c.again = false;
        for (;;) {
          if (c.closed) return;
          const rows = await q(
            this.o.pool,
            `SELECT ${EVENT_COLUMNS} FROM app.events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT ${PAGE}`,
            [c.sessionId, c.lastSent],
          );
          for (const r of rows) {
            const e = eventRowFromDb(r);
            if (e.seq <= c.lastSent) continue;
            this.write(c, `event: ${SSE_EVENT_NAMES.evt}\nid: ${e.seq}\ndata: ${JSON.stringify(toPublicEvent(e))}\n\n`);
            c.lastSent = e.seq;
          }
          if (rows.length < PAGE) break;
        }
      } while (c.again);
    } catch (err) {
      this.o.log.warn({ sessionId: c.sessionId, err: (err as Error).message }, 'sse pump failed; closing');
      this.close(c); // the browser reconnects with Last-Event-ID
    } finally {
      c.pumping = false;
    }
  }

  private onSessionMessage(channel: string, message: string): void {
    const sessionId = channel.slice('sse:session:'.length);
    const conns = this.bySession.get(sessionId);
    if (!conns || conns.size === 0) return;
    let m: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      m = parsed as Record<string, unknown>;
    } catch {
      this.drop('malformed', sessionId, 'unparsable sse message');
      return;
    }
    if (m.kind === 'evt') {
      for (const c of conns) void this.pump(c);
    } else if (m.kind === 'status') {
      if (typeof m.status !== 'string' || !STATUSES.has(m.status)) return this.drop('malformed', sessionId, 'status');
      const f = frame(SSE_EVENT_NAMES.status, { status: m.status });
      for (const c of conns) if (c.ready) this.write(c, f);
    } else if (m.kind === 'eph') {
      void this.onEphemeral(sessionId, message, m, conns);
    } else {
      this.drop('malformed', sessionId, 'unknown kind');
    }
  }

  private async onEphemeral(
    sessionId: string,
    raw: string,
    m: Record<string, unknown>,
    conns: Set<Conn>,
  ): Promise<void> {
    const event = m.event as Record<string, unknown> | undefined;
    // ① schema of the internal ephemeral envelope (fence inside, M-17)
    if (!check(EphemeralEnvelope, event) || event === undefined) return this.drop('schema', sessionId, 'schema');
    const keys = Object.keys(m);
    if (keys.some((k) => k !== 'kind' && k !== 'event' && k !== 'fence')) return this.drop('schema', sessionId, 'keys');
    if (m.fence !== undefined && m.fence !== event.fence) return this.drop('schema', sessionId, 'fence mismatch');
    // ② channel sid == event.sessionId
    if (event.sessionId !== sessionId) return this.drop('session', sessionId, 'session mismatch');
    // ④ size
    if (Buffer.byteLength(raw, 'utf8') > MAX_EPHEMERAL_BYTES) return this.drop('size', sessionId, 'too large');
    const type = String(event.type);
    if (this.o.agentDeltaMode === 'off' && (type === 'agent.delta' || type === 'agent.reasoning_delta')) {
      this.dropped.mode++;
      return;
    }
    // ③ fence: stale workers can neither push nor retract text
    let current: number;
    try {
      current = await this.currentFence(sessionId);
    } catch (err) {
      return this.drop('fence', sessionId, `fence lookup failed: ${(err as Error).message}`);
    }
    if (Number(event.fence) < current) return this.drop('fence', sessionId, 'stale fence');
    const pub = toPublicEphemeral(type, event.payload as Record<string, unknown>);
    if (!pub) return this.drop('schema', sessionId, 'type');
    const f = frame(SSE_EVENT_NAMES.eph, pub);
    for (const c of conns) if (c.ready) this.write(c, f);
  }

  private async currentFence(sessionId: string): Promise<number> {
    const now = Date.now();
    const hit = this.fenceCache.get(sessionId);
    if (hit && now - hit.at < (this.o.fenceCacheMs ?? 1000)) return hit.value;
    const v = Number((await this.o.redis.get(fenceKey(sessionId))) ?? '0');
    this.fenceCache.set(sessionId, { value: v, at: now });
    if (this.fenceCache.size > 10_000) this.fenceCache.clear();
    return v;
  }

  private drop(reason: keyof SseHub['dropped'], sessionId: string, msg: string): void {
    this.dropped[reason]++;
    this.o.log.warn({ sessionId, reason }, `ephemeral dropped: ${msg}`);
  }
}

function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
}
function remove<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  const s = m.get(k);
  if (!s) return;
  s.delete(v);
  if (s.size === 0) m.delete(k);
}
