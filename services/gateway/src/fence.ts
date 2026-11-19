// Lease-fence check (A-01 §5.1 step 4, D-34, I-3). Atomic in Redis; `m` is sessions.max_fence_seen read under the
// session row lock. When Redis has lost data (cur < m) the fence is raised above every known fence and the caller
// is rejected, so an old worker can never write again while a new worker's next INCR wins.
import type { Redis } from '@fb/platform/redis';

export const fenceKey = (sessionId: string): string => `lease:fence:${sessionId}`;

export const FENCE_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local f, m = tonumber(ARGV[1]), tonumber(ARGV[2])
if cur < m then
  redis.call('SET', KEYS[1], m + 1)
  return 'RESET'
end
if f < cur then return 'STALE' end
return 'OK'
`;

export type FenceResult = 'OK' | 'STALE' | 'RESET';

export async function checkFence(
  redis: Redis,
  sessionId: string,
  fence: number,
  maxFenceSeen: number,
): Promise<FenceResult> {
  const r = await redis.eval(FENCE_LUA, 1, fenceKey(sessionId), String(fence), String(maxFenceSeen));
  if (r === 'OK' || r === 'STALE' || r === 'RESET') return r;
  throw new Error(`unexpected fence script result ${String(r)}`);
}

/** X-Lease-Fence: a non-negative integer (A-02 §3.2). */
export function parseFence(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || !/^[0-9]{1,15}$/.test(v)) return null;
  return Number(v);
}
