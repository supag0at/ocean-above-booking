// Minimal SSE client over node:http for tests against a listening gateway (inject cannot stream).
import { request, type ClientRequest, type IncomingMessage } from 'node:http';

export interface Frame {
  event?: string;
  id?: string;
  data?: string;
  retry?: string;
  comment?: string;
}

export class SseClient {
  readonly frames: Frame[] = [];
  status = 0;
  ended = false;
  private req?: ClientRequest;
  private res?: IncomingMessage;
  private buf = '';
  private waiters: (() => void)[] = [];

  static open(url: string, headers: Record<string, string>): Promise<SseClient> {
    const c = new SseClient();
    return new Promise((resolve, reject) => {
      c.req = request(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
        c.res = res;
        c.status = res.statusCode ?? 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => c.feed(chunk));
        res.on('end', () => {
          c.ended = true;
          c.notify();
        });
        res.on('close', () => {
          c.ended = true;
          c.notify();
        });
        resolve(c);
      });
      c.req.on('error', reject);
      c.req.end();
    });
  }

  /** body of a non-SSE (error) response */
  async text(): Promise<string> {
    await this.until(() => this.ended, 5000, 'end');
    return this.buf;
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    if (this.status !== 200) return;
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const f: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) f.comment = line.slice(1).trim();
        else {
          const j = line.indexOf(':');
          const k = line.slice(0, j);
          const v = line.slice(j + 1).replace(/^ /, '');
          if (k === 'event' || k === 'id' || k === 'data' || k === 'retry') f[k] = v;
        }
      }
      this.frames.push(f);
    }
    this.notify();
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async until(pred: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      const left = end - Date.now();
      if (left <= 0) throw new Error(`SSE timeout waiting for ${what}; frames=${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 200));
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  evts(): { id: number; data: Record<string, unknown> }[] {
    return this.frames
      .filter((f) => f.event === 'evt')
      .map((f) => ({ id: Number(f.id), data: JSON.parse(f.data ?? '{}') as Record<string, unknown> }));
  }
  ephs(): Record<string, unknown>[] {
    return this.frames
      .filter((f) => f.event === 'eph')
      .map((f) => JSON.parse(f.data ?? '{}') as Record<string, unknown>);
  }
  statuses(): string[] {
    return this.frames
      .filter((f) => f.event === 'status')
      .map((f) => (JSON.parse(f.data ?? '{}') as { status: string }).status);
  }

  close(): void {
    this.res?.destroy();
    this.req?.destroy();
  }
}
