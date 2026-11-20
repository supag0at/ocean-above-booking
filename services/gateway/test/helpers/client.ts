// Browser / harness simulators over Fastify inject.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from '@fb/platform/fastify';
import { HARNESS_TOKEN, ORIGIN } from './env.ts';

export interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | undefined>;
}

const toRes = (r: { statusCode: number; body: string; headers: Record<string, unknown> }): Res => {
  let body: unknown = r.body;
  try {
    body = r.body === '' ? undefined : JSON.parse(r.body);
  } catch {
    /* text */
  }
  return { status: r.statusCode, body, headers: r.headers as Res['headers'] };
};

export class Browser {
  sid = '';
  csrf = '';
  userId = '';
  readonly app: FastifyInstance;
  constructor(app: FastifyInstance) {
    this.app = app;
  }

  cookieHeader(): string {
    return this.sid ? `fb_sid=${this.sid}; fb_csrf=${this.csrf}` : '';
  }

  async login(username = `u${randomUUID().slice(0, 8)}`): Promise<Res> {
    const r = await this.raw('POST', '/api/v1/auth/login', { username }, { csrf: false });
    const cookies = ([] as string[]).concat((r.headers['set-cookie'] as string[] | string | undefined) ?? []);
    for (const c of cookies) {
      const [kv] = c.split(';');
      const [k, v] = (kv ?? '').split('=');
      if (k === 'fb_sid') this.sid = v ?? '';
      if (k === 'fb_csrf') this.csrf = v ?? '';
    }
    if (r.status === 200) this.userId = r.body.user.id;
    return r;
  }

  /** Full control request. Defaults: correct Origin, CSRF token and JSON content-type when there is a body. */
  async raw(
    method: string,
    url: string,
    payload?: unknown,
    o: {
      origin?: string | null;
      csrf?: boolean | string;
      contentType?: string | null;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { ...o.headers };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') {
      if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
      if (o.csrf !== false) headers['x-csrf-token'] = typeof o.csrf === 'string' ? o.csrf : this.csrf;
    }
    if (payload !== undefined && o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
    const r = await this.app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(payload !== undefined ? { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
    });
    return toRes(r);
  }

  get = (url: string, headers?: Record<string, string>): Promise<Res> =>
    this.raw('GET', url, undefined, headers ? { headers } : {});
  post = (url: string, body?: unknown): Promise<Res> => this.raw('POST', url, body);

  async newSession(locale?: 'zh' | 'en'): Promise<string> {
    const r = await this.post('/api/v1/sessions', locale ? { locale } : {});
    if (r.status !== 201) throw new Error(`create session ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.session.id;
  }

  async say(sessionId: string, text: string, clientMessageId: string = randomUUID()): Promise<Res> {
    return this.post(`/api/v1/sessions/${sessionId}/messages`, { text, clientMessageId });
  }
}

export class Harness {
  readonly app: FastifyInstance;
  token = HARNESS_TOKEN;
  constructor(app: FastifyInstance) {
    this.app = app;
  }
  async req(
    method: string,
    url: string,
    o: { fence?: number | string; body?: unknown; raw?: string } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (o.fence !== undefined) headers['x-lease-fence'] = String(o.fence);
    if (o.body !== undefined || o.raw !== undefined) headers['content-type'] = 'application/json';
    const r = await this.app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(o.raw !== undefined ? { payload: o.raw } : o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
    });
    return toRes(r);
  }
  emit(sessionId: string, fence: number, ev: { type: string; payload: unknown; idempotencyKey: string }): Promise<Res> {
    return this.req('POST', `/internal/v1/sessions/${sessionId}/events`, { fence, body: ev });
  }
}
