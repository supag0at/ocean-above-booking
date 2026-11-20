// Narrowed Redis ACL for the `gateway` user (A-01 §7.2: "narrow the categories to the concrete commands, verified
// against the real BullMQ version"). Verified with bullmq 6.7.7 / ioredis 6 / Redis 7 by MONITOR + `ACL LOG`
// (test/redis-acl.test.ts). Redis checks commands issued *inside* Lua scripts against the caller's ACL too, so the
// list includes what BullMQ's addStandardJob script and the fence script (§5.1 step 4) call.
// The compose users.acl (infra) should render this rule; it is not read at runtime.

export const GATEWAY_ACL_KEYS = ['auth:*', 'bull:harness-wake:*', 'lease:fence:*', 'sweeper:lock'] as const;
export const GATEWAY_ACL_CHANNELS = ['sse:*'] as const;

export const GATEWAY_ACL_COMMANDS = [
  // connection: ioredis handshake / readiness, BullMQ reads the server version with INFO on connect
  'ping',
  'info',
  'client|setname',
  // auth:sess:{k} (A-01 §4.2)
  'hset',
  'hgetall',
  'expire',
  'del',
  'multi',
  'exec',
  // fence script (lease:fence:*), sweeper:lock, BullMQ scripts
  'eval',
  'evalsha',
  'get',
  'set',
  // inside BullMQ addStandardJob (bull:harness-wake:*)
  'exists',
  'hget',
  'hmget',
  'hmset',
  'incr',
  'lpush',
  'xadd',
  'zadd',
  // SSE fan-out (sse:session:{sid}, sse:logout)
  'publish',
  'psubscribe',
  'punsubscribe',
] as const;

/** One users.acl line for the gateway user; `passwordSha256` is the hex sha256 of the password. */
export function gatewayAclRule(passwordSha256: string): string {
  return [
    'user gateway on',
    `#${passwordSha256}`,
    'resetkeys',
    ...GATEWAY_ACL_KEYS.map((k) => `~${k}`),
    'resetchannels',
    ...GATEWAY_ACL_CHANNELS.map((c) => `&${c}`),
    '-@all',
    ...GATEWAY_ACL_COMMANDS.map((c) => `+${c}`),
  ].join(' ');
}
