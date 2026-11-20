// In-memory Redis stand-in that understands exactly the three lease scripts (by identity) plus GET/publish.
// test/lease.test.ts runs the same contract tests against this fake AND a real redis:7 (when REDIS_URL is
// reachable), which is what makes the fake trustworthy for the runner tests.
import { ACQUIRE_LUA, RELEASE_LUA, RENEW_LUA, type LeaseRedis } from '../../src/lease.ts';

export class FakeRedis implements LeaseRedis {
  private readonly kv = new Map<string, { v: string; exp?: number }>();
  readonly published: { channel: string; message: string }[] = [];
  /** when set, every call hangs forever (a frozen / killed process) */
  frozen = false;
  now: () => number = () => Date.now();

  private live(k: string): string | undefined {
    const e = this.kv.get(k);
    if (e === undefined) return undefined;
    if (e.exp !== undefined && e.exp <= this.now()) {
      this.kv.delete(k);
      return undefined;
    }
    return e.v;
  }

  get(k: string): string | undefined {
    return this.live(k);
  }
  set(k: string, v: string): void {
    this.kv.set(k, { v });
  }
  del(k: string): void {
    this.kv.delete(k);
  }

  private hang<T>(): Promise<T> {
    return new Promise<T>(() => undefined);
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.frozen) return this.hang();
    const [k1, a, b, c] = args.map(String);
    if (script === ACQUIRE_LUA) {
      // KEYS[1]=lease KEYS[2]=fence ARGV[1]=worker ARGV[2]=ttl
      const lease = k1 as string;
      const fence = a as string;
      if (this.live(lease) !== undefined) return null;
      const f = Number(this.live(fence) ?? '0') + 1;
      this.kv.set(fence, { v: String(f) });
      this.kv.set(lease, { v: `${b}:${f}`, exp: this.now() + Number(c) });
      return f;
    }
    if (script === RENEW_LUA) {
      if (this.live(k1 as string) !== a) return 0;
      this.kv.set(k1 as string, { v: a as string, exp: this.now() + Number(b) });
      return 1;
    }
    if (script === RELEASE_LUA) {
      if (this.live(k1 as string) !== a) return 0;
      this.kv.delete(k1 as string);
      return 1;
    }
    throw new Error('FakeRedis: unknown script');
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.frozen) return this.hang();
    this.published.push({ channel, message });
    return 1;
  }
}
