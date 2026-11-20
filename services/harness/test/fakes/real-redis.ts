// A REAL redis:7 for the lease / recovery tests. D-74: the suite starts its own container through the Docker
// Engine API and fails when Docker is not running. It never skips. child_process is banned in services/**.
import { request } from 'node:http';
import { createRedis, type Redis } from '@fb/platform/redis';

const SOCKET = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
const PASSWORD = 't09-local-test';

function docker(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export async function startRealRedis(): Promise<{ redis: Redis; stop: () => Promise<void> }> {
  const ping = await docker('GET', '/_ping').catch((e: Error) => {
    throw new Error(`Docker is not running (${e.message}); D-74: these tests must fail, not skip`);
  });
  if (ping.status !== 200) throw new Error(`docker ping -> ${ping.status}`);
  const name = `fb-t09-redis-${Math.random().toString(36).slice(2, 8)}`;
  const created = await docker('POST', `/containers/create?name=${name}`, {
    Image: 'redis:7',
    Cmd: ['redis-server', '--requirepass', PASSWORD],
    ExposedPorts: { '6379/tcp': {} },
    Labels: { 'fb.test': 'harness' },
    HostConfig: { PortBindings: { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
  });
  if (created.status >= 300) throw new Error(`create redis -> ${created.status}: ${created.body}`);
  const id = (JSON.parse(created.body) as { Id: string }).Id;
  const stop = async (): Promise<void> => {
    await docker('DELETE', `/containers/${id}?force=1&v=1`);
  };
  const started = await docker('POST', `/containers/${id}/start`);
  if (started.status >= 300) {
    await stop();
    throw new Error(`start redis -> ${started.status}: ${started.body}`);
  }
  const info = await docker('GET', `/containers/${id}/json`);
  const port = Number(
    (JSON.parse(info.body) as { NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> } })
      .NetworkSettings.Ports['6379/tcp']?.[0]?.HostPort,
  );
  const redis = createRedis({
    host: '127.0.0.1',
    port,
    username: 'default',
    secrets: { get: () => PASSWORD },
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeoutMs: 1000,
  });
  await redis.connect();
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      await redis.ping();
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) {
    redis.disconnect();
    await stop();
    throw new Error('redis container did not become ready');
  }
  return { redis, stop };
}
