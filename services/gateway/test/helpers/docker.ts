// Tiny Docker Engine API client over the local socket / named pipe (node:http only). child_process is banned in
// services/** (A-01 §1.2 lint + depcruise), so tests talk to the daemon directly instead of spawning `docker`.
import { request } from 'node:http';

const SOCKET = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';

interface Res {
  status: number;
  body: Buffer;
}

function call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ok(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`docker ${method} ${path} -> ${r.status}: ${r.body.toString('utf8')}`);
  return r.body.length > 0 && r.body[0] === 0x7b ? (JSON.parse(r.body.toString('utf8')) as unknown) : undefined;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await call('GET', '/_ping', undefined, 3000)).status === 200;
  } catch {
    return false;
  }
}

export async function imagePresent(image: string): Promise<boolean> {
  return (await call('GET', `/images/${encodeURIComponent(image)}/json`)).status === 200;
}

export interface RunOptions {
  readonly image: string;
  readonly name: string;
  readonly env?: Record<string, string>;
  readonly cmd?: string[];
  readonly binds?: string[];
  /** container port, e.g. "5432/tcp"; published on 127.0.0.1 with a random host port */
  readonly port: string;
}

export interface Container {
  readonly id: string;
  readonly hostPort: number;
  logs(): Promise<string>;
  remove(): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

export async function runContainer(o: RunOptions): Promise<Container> {
  const created = (await ok('POST', `/containers/create?name=${encodeURIComponent(o.name)}`, {
    Image: o.image,
    Env: Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`),
    ...(o.cmd ? { Cmd: o.cmd } : {}),
    ExposedPorts: { [o.port]: {} },
    Labels: { 'fb.test': 'gateway' },
    HostConfig: {
      Binds: o.binds ?? [],
      PortBindings: { [o.port]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
    },
  })) as { Id: string };
  const id = created.Id;
  await ok('POST', `/containers/${id}/start`);
  const info = (await ok('GET', `/containers/${id}/json`)) as {
    NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> };
  };
  const hostPort = Number(info.NetworkSettings.Ports[o.port]?.[0]?.HostPort);
  if (!Number.isInteger(hostPort) || hostPort <= 0) throw new Error(`no host port for ${o.name}`);
  return {
    id,
    hostPort,
    async logs() {
      const r = await call('GET', `/containers/${id}/logs?stdout=1&stderr=1`);
      return demux(r.body);
    },
    async remove() {
      await call('DELETE', `/containers/${id}?force=1&v=1`);
    },
    async stop() {
      await ok('POST', `/containers/${id}/stop?t=1`);
    },
    async start() {
      await ok('POST', `/containers/${id}/start`);
    },
  };
}

/** Docker multiplexed log stream: 8-byte header (stream, 0,0,0, size BE32) + payload. */
function demux(buf: Buffer): string {
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out || buf.toString('utf8');
}
