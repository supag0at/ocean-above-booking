import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

export const GATEWAY = 'ocean-above-gateway-1';
export const ORIGIN = 'http://127.0.0.1';

export const SEED_TITLE = 'San Jose → Tokyo';
export const SEED_MESSAGE = '我想从 San Jose 飞到 Tokyo';
export const FLIGHT = '从上海飞圣保罗';
export const CONFIRM_TEXT = '确认';

export interface QuoteBody {
  from: string;
  to: string;
  transferCities: string[];
  display: { priceUsd: string };
}

export interface PublicEvent {
  seq: number;
  type: string;
  payload: {
    text?: string;
    kind?: string;
    template?: string;
    toolCallId?: string;
    quoteId?: string;
    ticketNo?: string;
  };
}

export function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { windowsHide: true, timeout: 90_000, encoding: 'utf8', maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(redact(`docker ${args.join(' ')} failed: ${stderr || err.message}`)));
          return;
        }
        resolve(`${stdout}${stderr}`);
      },
    );
  });
}

export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/(api[_-]?key|password|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]');
}

export async function attachContainerLogs(label: string): Promise<void> {
  for (const name of [GATEWAY, 'ocean-above-harness-1', 'ocean-above-caddy-1', 'ocean-above-booking-1']) {
    try {
      const text = redact(await docker(['logs', '--tail', '160', name]));
      await test.info().attach(`${label}-${name}.log`, { body: text, contentType: 'text/plain' });
    } catch (err) {
      await test.info().attach(`${label}-${name}.log`, {
        body: redact(err instanceof Error ? err.message : String(err)),
        contentType: 'text/plain',
      });
    }
  }
}

export async function login(page: Page, username: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/chat\/[^/]+$/);
  await page.locator('.username').waitFor({ state: 'visible' });
}

export function sessionIdOf(url: string): string {
  const match = new URL(url).pathname.match(/^\/chat\/([^/]+)$/);
  if (!match?.[1]) throw new Error(`not a chat url: ${url}`);
  return decodeURIComponent(match[1]);
}

export async function allEvents(page: Page, sessionId: string): Promise<PublicEvent[]> {
  const events: PublicEvent[] = [];
  let after = 0;
  for (;;) {
    const res = await page.request.get(`/api/v1/sessions/${sessionId}/events?afterSeq=${after}&limit=200`);
    if (!res.ok()) throw new Error(`events HTTP ${res.status()}`);
    const body = (await res.json()) as { events: PublicEvent[]; hasMore?: boolean };
    events.push(...body.events);
    const last = body.events[body.events.length - 1];
    if (body.hasMore !== true || last === undefined) return events;
    after = last.seq;
  }
}

/** Persisted assistant turns. Each one is one DeepSeek request that was kept; templates are not model calls. */
export function countModelTurns(events: PublicEvent[]): number {
  let n = 0;
  for (const event of events) {
    if (event.type !== 'agent.message') continue;
    if (event.payload.toolCallId) continue;
    if (event.payload.kind === 'process') n += 1;
    else if (event.payload.kind === 'reply' && typeof event.payload.template !== 'string') n += 1;
  }
  return n;
}

export async function waitUntilReplySettled(page: Page, sessionId: string, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const [sessionRes, eventsRes] = await Promise.all([
          page.request.get(`/api/v1/sessions/${sessionId}`),
          page.request.get(`/api/v1/sessions/${sessionId}/events?afterSeq=0&limit=200`),
        ]);
        if (!sessionRes.ok() || !eventsRes.ok()) return `http ${sessionRes.status()}/${eventsRes.status()}`;
        const session = (await sessionRes.json()) as { session: { status: string } };
        const body = (await eventsRes.json()) as { events: PublicEvent[] };
        const message = [...body.events]
          .reverse()
          .find((event) => event.type === 'user.message' && event.payload.text === text);
        if (!message) return 'waiting-for-message';
        const settled = body.events.some(
          (event) =>
            (event.type === 'agent.run_completed' || event.type === 'agent.run_failed') && event.seq > message.seq,
        );
        if (session.session.status === 'error') return 'error';
        if (session.session.status === 'idle' && settled) return 'idle';
        return session.session.status;
      },
      { timeout: 150_000, intervals: [1_000, 2_000, 2_000] },
    )
    .toBe('idle');
}

export async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator('textarea').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('user-bubble').filter({ hasText: text })).toBeVisible();
}

export function quoteIdFromUrl(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/\/api\/v1\/quotes\/([^/]+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function readQuote(body: unknown): QuoteBody | null {
  if (typeof body !== 'object' || body === null || !('quote' in body)) return null;
  const view = (body as { quote?: { quote?: Partial<QuoteBody> } }).quote?.quote;
  if (!view || typeof view.from !== 'string' || typeof view.to !== 'string') return null;
  if (!Array.isArray(view.transferCities) || typeof view.display?.priceUsd !== 'string') return null;
  return {
    from: view.from,
    to: view.to,
    transferCities: view.transferCities.filter((city): city is string => typeof city === 'string'),
    display: { priceUsd: view.display.priceUsd },
  };
}

export function routeLineOf(quote: QuoteBody): string {
  return [quote.from, ...quote.transferCities, quote.to].join(' → ');
}

export async function replayConfirm(
  page: Page,
  quoteId: string,
): Promise<{ status: number; ticketNo: string; alreadyBooked: boolean }> {
  return page.evaluate(async (id) => {
    const raw = document.cookie.split('; ').find((part) => part.startsWith('fb_csrf='));
    const csrf = raw ? decodeURIComponent(raw.slice('fb_csrf='.length)) : '';
    const res = await fetch(`/api/v1/quotes/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    });
    const body = (await res.json()) as { ticket?: { ticketNo?: string }; alreadyBooked?: boolean };
    return {
      status: res.status,
      ticketNo: body.ticket?.ticketNo ?? '',
      alreadyBooked: body.alreadyBooked === true,
    };
  }, quoteId);
}

export function writeModelSummary(summary: unknown): void {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/model-calls.json', `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

export async function gatewayHealth(): Promise<string> {
  return (await docker(['inspect', '-f', '{{.State.Health.Status}}', GATEWAY])).trim();
}

export async function waitGatewayHealthy(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await gatewayHealth().catch((err: unknown) => (err instanceof Error ? err.message : 'inspect-failed'));
    if (last === 'healthy') return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`gateway did not become healthy (last: ${last})`);
}
