// Lease + fence (A-02 §3.2): ONE Lua script acquires and increments the fence atomically (fix B1, A2-5).
// A failed acquire never touches the fence, so surplus doorbells can never make the holder's writes stale.

/** Minimal Redis surface used here (ioredis `eval`). */
export interface LeaseRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;

export const leaseKey = (sid: string): string => `lease:session:${sid}`;
export const fenceKey = (sid: string): string => `lease:fence:${sid}`;

export const ACQUIRE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
local f = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. f, 'PX', ARGV[2])
return f`;

export const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

export const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export interface Lease {
  readonly sessionId: string;
  readonly fence: number;
  /** "{workerId}:{fence}" — the exact value renew/release compare against */
  readonly value: string;
}

export class LeaseStore {
  private readonly redis: LeaseRedis;
  private readonly workerId: string;
  private readonly ttlMs: number;
  constructor(redis: LeaseRedis, workerId: string, ttlMs: number = LEASE_TTL_MS) {
    this.redis = redis;
    this.workerId = workerId;
    this.ttlMs = ttlMs;
    if (workerId.includes(':')) throw new Error('workerId must not contain ":"');
  }

  /** Returns the lease, or null when someone else holds it (fence untouched). */
  async acquire(sessionId: string): Promise<Lease | null> {
    const r = await this.redis.eval(
      ACQUIRE_LUA,
      2,
      leaseKey(sessionId),
      fenceKey(sessionId),
      this.workerId,
      this.ttlMs,
    );
    // Lua `false` comes back as null
    if (r === null || r === undefined || r === false) return null;
    const fence = Number(r);
    if (!Number.isInteger(fence) || fence < 1) throw new Error(`unexpected acquire result ${String(r)}`);
    return { sessionId, fence, value: `${this.workerId}:${fence}` };
  }

  /** true while the lease value is still ours. */
  async renew(lease: Lease): Promise<boolean> {
    const r = await this.redis.eval(RENEW_LUA, 1, leaseKey(lease.sessionId), lease.value, this.ttlMs);
    return Number(r) === 1;
  }

  /** Deletes the lease only if it is still ours (no-op otherwise, §3.2 / §19 #3). */
  async release(lease: Lease): Promise<boolean> {
    const r = await this.redis.eval(RELEASE_LUA, 1, leaseKey(lease.sessionId), lease.value);
    return Number(r) === 1;
  }
}

/**
 * Keeps a lease alive (renew every 10s). `onLost` fires once when a renew finds the value is no longer ours or the
 * renew call itself fails; after that the holder must stop emitting (§3.2).
 */
export class LeaseKeeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lostFlag = false;
  private readonly lostCallbacks: (() => void)[] = [];

  private readonly store: LeaseStore;
  readonly lease: Lease;
  private readonly renewMs: number;
  constructor(store: LeaseStore, lease: Lease, renewMs: number = LEASE_RENEW_MS) {
    this.store = store;
    this.lease = lease;
    this.renewMs = renewMs;
  }

  get lost(): boolean {
    return this.lostFlag;
  }
  get fence(): number {
    return this.lease.fence;
  }

  onLost(cb: () => void): void {
    if (this.lostFlag) cb();
    else this.lostCallbacks.push(cb);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.store.renew(this.lease).then(
        (ok) => {
          if (!ok) this.markLost();
        },
        () => this.markLost(),
      );
    }, this.renewMs);
    this.timer.unref?.();
  }

  markLost(): void {
    if (this.lostFlag) return;
    this.lostFlag = true;
    for (const cb of this.lostCallbacks.splice(0)) cb();
  }

  async stopAndRelease(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    // release is a no-op when the value is no longer ours
    await this.store.release(this.lease).catch(() => false);
  }
}
