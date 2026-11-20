// Six browser journeys against the already-running stack (http://127.0.0.1).
// Model calls: only the two user messages 「从上海飞圣保罗」 and 「确认」.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  CONFIRM_TEXT,
  FLIGHT,
  GATEWAY,
  SEED_MESSAGE,
  SEED_TITLE,
  allEvents,
  attachContainerLogs,
  countModelTurns,
  docker,
  login,
  quoteIdFromUrl,
  readQuote,
  replayConfirm,
  routeLineOf,
  sendChat,
  sessionIdOf,
  waitGatewayHealthy,
  waitUntilReplySettled,
  writeModelSummary,
  type QuoteBody,
} from './support.ts';

const quotes = new Map<string, QuoteBody>();
const lastEventIds: string[] = [];

const world = {
  userA: '',
  userB: '',
  sessionId: '',
  quoteId: '',
  routeLine: '',
  priceText: '',
  ticketNo: '',
  ticketId: '',
  modelTurns: -1,
};

let context: BrowserContext | undefined;
let page: Page | undefined;

function chat(): Page {
  if (!page) throw new Error('page was not created');
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const stamp = Date.now().toString(36);
  world.userA = `e2ea${stamp}`;
  world.userB = `e2eb${stamp}`;
  context = await browser.newContext({ baseURL: 'http://127.0.0.1', locale: 'zh-CN' });
  page = await context.newPage();
  page.on('response', (res) => {
    const id = quoteIdFromUrl(res.url());
    if (!id || res.request().method() !== 'GET' || !res.ok()) return;
    void res
      .json()
      .then((body) => {
        const quote = readQuote(body);
        if (quote) quotes.set(id, quote);
      })
      .catch(() => undefined);
  });
  page.on('request', (req) => {
    if (!req.url().includes('/stream')) return;
    const id = req.headers()['last-event-id'];
    if (id) lastEventIds.push(id);
  });
});

test.afterEach(async () => {
  if (test.info().status === test.info().expectedStatus) return;
  await attachContainerLogs('failure').catch(() => undefined);
});

test.afterAll(async () => {
  await docker(['start', GATEWAY]).catch(() => undefined);
  await waitGatewayHealthy().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
  });
  await context?.close();
});

test('1. 只填用户名登录，会话列表没有 MSW 种子', async () => {
  const current = chat();
  await current.goto('/login');
  await expect(current.getByRole('heading', { name: '登录 Ocean Above' })).toBeVisible();
  await expect(current.getByText('输入用户名即可登录，不存在会自动注册')).toBeVisible();
  await expect(current.locator('input[type="password"]')).toHaveCount(0);
  await expect(current.locator('input')).toHaveCount(1);

  await login(current, world.userA);
  world.sessionId = sessionIdOf(current.url());
  await expect(current.locator('.username')).toHaveText(world.userA);
  await expect(current.getByText('告诉我出发地和目的地')).toBeVisible();
  await expect(current.getByTestId('user-bubble')).toHaveCount(0);
  await expect(current.getByText(SEED_TITLE)).toHaveCount(0);
  await expect(current.getByText(SEED_MESSAGE)).toHaveCount(0);

  await current.getByRole('link', { name: '历史对话', exact: true }).click();
  await expect(current.getByRole('heading', { name: '历史对话' })).toBeVisible();
  await expect(current.getByText(SEED_TITLE)).toHaveCount(0);
  await expect(current.getByText(SEED_MESSAGE)).toHaveCount(0);
  await expect(current.getByTestId('session-link')).toHaveCount(1);
  await expect(current.getByTestId('session-link')).toContainText('未命名对话');

  await current.getByRole('link', { name: '我的机票', exact: true }).click();
  await expect(current.getByText('你还没有机票')).toBeVisible();
  await expect(current.getByTestId('ticket-item')).toHaveCount(0);

  await current.getByRole('link', { name: '画像', exact: true }).click();
  await expect(current.getByText('还没有记忆的偏好')).toBeVisible();
  await expect(current.getByText('San José')).toHaveCount(0);

  await current.goto(`/chat/${world.sessionId}`);
  await expect(current.getByText('告诉我出发地和目的地')).toBeVisible();
});

test('2. 发送「从上海飞圣保罗」，报价卡与 GET /quotes/:id 一致', async () => {
  const current = chat();
  await sendChat(current, FLIGHT);
  await expect(current.getByTestId('quote-card').first()).toBeVisible({ timeout: 150_000 });
  await waitUntilReplySettled(current, world.sessionId, FLIGHT);

  const card = current.getByTestId('quote-card').first();
  const quoteId = await card.getAttribute('data-quote-id');
  expect(quoteId).toBeTruthy();
  world.quoteId = quoteId ?? '';
  await expect.poll(() => quotes.get(world.quoteId)?.display.priceUsd ?? '', { timeout: 20_000 }).not.toBe('');
  const quote = quotes.get(world.quoteId);
  if (!quote) throw new Error(`missing GET /quotes/${world.quoteId}`);
  world.routeLine = routeLineOf(quote);
  world.priceText = `${quote.display.priceUsd} USD`;

  await expect(card.getByTestId('route-line')).toHaveText(world.routeLine);
  await expect(card.getByTestId('price')).toHaveText(world.priceText);
  await expect(card.getByTestId('route-line')).toContainText(quote.from);
  await expect(card.getByTestId('route-line')).toContainText(quote.to);
  await expect(card.getByText(SEED_TITLE)).toHaveCount(0);
  await expect(current.getByTestId('ticket-card')).toHaveCount(0);
});

test('3. 输入「确认」不出票，点击报价卡才出票，再确认仍是一张', async () => {
  const current = chat();
  let confirmPosts = 0;
  const countConfirm = (res: { url(): string; request(): { method(): string } }): void => {
    if (res.request().method() === 'POST' && res.url().includes('/quotes/') && res.url().includes('/confirm')) {
      confirmPosts += 1;
    }
  };
  current.on('response', countConfirm);
  await sendChat(current, CONFIRM_TEXT);
  await waitUntilReplySettled(current, world.sessionId, CONFIRM_TEXT);
  current.off('response', countConfirm);
  expect(confirmPosts).toBe(0);
  await expect(current.getByTestId('ticket-card')).toHaveCount(0);
  await expect(current.getByTestId('booked-state')).toHaveCount(0);
  await expect(current.getByTestId('confirm-button')).toHaveText('确认下单');
  await expect(current.getByText('只有点击此按钮才会出票')).toBeVisible();

  await current.getByRole('link', { name: '我的机票', exact: true }).click();
  await expect(current.getByText('你还没有机票')).toBeVisible();
  await current.goto(`/chat/${world.sessionId}`);
  await expect(current.getByTestId('confirm-button')).toHaveText('确认下单');

  const created = current.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes(`/quotes/${world.quoteId}/confirm`),
  );
  await current.getByTestId('confirm-button').click();
  const createdRes = await created;
  expect(createdRes.status()).toBe(201);
  const createdBody = (await createdRes.json()) as {
    ticket: { ticketNo: string; ticketId: string };
    alreadyBooked?: boolean;
  };
  expect(createdBody.alreadyBooked).toBeUndefined();
  world.ticketNo = createdBody.ticket.ticketNo;
  world.ticketId = createdBody.ticket.ticketId;

  await expect(current.getByTestId('ticket-card')).toHaveCount(1);
  await expect(current.getByTestId('ticket-no')).toHaveText(world.ticketNo);
  await expect(current.getByTestId('booked-state')).toContainText(world.ticketNo);
  await expect(current.getByTestId('confirm-button')).toHaveCount(0);

  // The button is removed once the card is booked, so the same browser session repeats the button's request.
  const replay = await replayConfirm(current, world.quoteId);
  expect(replay.status).toBe(200);
  expect(replay.alreadyBooked).toBe(true);
  expect(replay.ticketNo).toBe(world.ticketNo);
  await expect(current.getByTestId('ticket-card')).toHaveCount(1);

  await current.getByRole('link', { name: '我的机票', exact: true }).click();
  await expect(current.getByTestId('ticket-item')).toHaveCount(1);
  await expect(current.getByText(world.ticketNo)).toBeVisible();

  const events = await allEvents(current, world.sessionId);
  world.modelTurns = countModelTurns(events);
  const summary = {
    modelTurns: world.modelTurns,
    process: events.filter((event) => event.type === 'agent.message' && event.payload.kind === 'process').length,
    reply: events.filter(
      (event) =>
        event.type === 'agent.message' && event.payload.kind === 'reply' && typeof event.payload.template !== 'string',
    ).length,
    template: events.filter((event) => event.type === 'agent.message' && typeof event.payload.template === 'string')
      .length,
    runFailed: events.filter((event) => event.type === 'agent.run_failed').length,
    runCompleted: events.filter((event) => event.type === 'agent.run_completed').length,
  };
  writeModelSummary(summary);
  console.log(`DEEPSEEK_TURNS ${JSON.stringify(summary)}`);
  expect(world.modelTurns).toBeGreaterThan(0);
});

test('4. 刷新后对话还在，断线后续上带 Last-Event-ID', async () => {
  const current = chat();
  await current.goto(`/chat/${world.sessionId}`);
  await expect(current.getByTestId('user-bubble').filter({ hasText: FLIGHT })).toBeVisible();
  const before = lastEventIds.length;
  if (!context) throw new Error('context missing');
  try {
    await context.setOffline(true);
    await current.waitForTimeout(800);
  } finally {
    await context.setOffline(false);
  }
  await expect.poll(() => lastEventIds.length, { timeout: 20_000 }).toBeGreaterThan(before);
  expect(lastEventIds.at(-1)).toMatch(/^\d+$/);
  await expect(current.getByTestId('user-bubble').filter({ hasText: FLIGHT })).toBeVisible();
  await expect(current.getByTestId('user-bubble').filter({ hasText: CONFIRM_TEXT })).toBeVisible();

  const stream = current.waitForRequest((req) => req.url().includes('/stream'));
  await current.reload();
  await stream;
  await expect(current.locator('.username')).toHaveText(world.userA);
  await expect(current.getByTestId('user-bubble').filter({ hasText: FLIGHT })).toBeVisible();
  await expect(current.getByTestId('user-bubble').filter({ hasText: CONFIRM_TEXT })).toBeVisible();
  await expect(current.getByTestId('quote-card')).toBeVisible();
  await expect(current.getByTestId('quote-card').getByTestId('route-line')).toHaveText(world.routeLine);
  await expect(current.getByTestId('quote-card').getByTestId('price')).toHaveText(world.priceText);
  await expect(current.getByTestId('ticket-card')).toHaveCount(1);
  await expect(current.getByTestId('ticket-no')).toHaveText(world.ticketNo);
  await expect(current.getByText('中间过程，不作为报价依据').first()).toBeVisible();
  const areas = current.getByTestId('process-area');
  const areaCount = await areas.count();
  for (let i = 0; i < areaCount; i += 1) {
    await expect(areas.nth(i)).toHaveAttribute('data-expanded', 'false');
  }
});

test('5. 停掉 gateway 后静态页仍在，恢复后可以重新登录', async () => {
  const current = chat();
  try {
    await docker(['stop', '-t', '20', GATEWAY]);
    const response = await current.goto('/login', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await expect(current.getByRole('heading', { name: '登录 Ocean Above' })).toBeVisible();
    const asset = await current.evaluate(async () => {
      const src = document.querySelector('script[src]')?.getAttribute('src') ?? '';
      if (!src) return { src, status: 0 };
      const res = await fetch(src);
      return { src, status: res.status };
    });
    expect(asset.src).not.toBe('');
    expect(asset.status).toBe(200);
    const api = await current.request.get('/api/v1/healthz', { timeout: 5_000 }).catch(() => null);
    expect(api === null || api.status() >= 500).toBe(true);
  } finally {
    await docker(['start', GATEWAY]);
  }
  await waitGatewayHealthy();
  await expect
    .poll(
      async () => {
        const res = await current.request.get('/api/v1/healthz').catch(() => null);
        return res?.status() ?? 0;
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  await login(current, world.userA);
  await expect(current.locator('.username')).toHaveText(world.userA);
});

test('6. 用户 A 和用户 B 互相看不到对方的会话和机票', async () => {
  if (!context) throw new Error('context missing');
  const browser = context.browser();
  if (!browser) throw new Error('browser missing');
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1', locale: 'zh-CN' });
  const userB = await other.newPage();
  try {
    await login(userB, world.userB);
    const sessionB = sessionIdOf(userB.url());
    await expect(userB.locator('.username')).toHaveText(world.userB);
    await userB.getByRole('link', { name: '历史对话', exact: true }).click();
    await expect(userB.getByRole('heading', { name: '历史对话' })).toBeVisible();
    await expect(userB.getByText(FLIGHT)).toHaveCount(0);
    await expect(userB.getByText(world.ticketNo)).toHaveCount(0);
    await expect(userB.getByTestId('session-link')).toHaveCount(1);
    await expect(userB.getByTestId('session-link')).toContainText('未命名对话');

    await userB.getByRole('link', { name: '我的机票', exact: true }).click();
    await expect(userB.getByText('你还没有机票')).toBeVisible();
    await expect(userB.getByText(world.ticketNo)).toHaveCount(0);

    await userB.goto(`/chat/${world.sessionId}`);
    await expect(userB.getByText('找不到这个对话')).toBeVisible();
    await expect(userB.getByText(FLIGHT)).toHaveCount(0);
    await expect(userB.getByTestId('quote-card')).toHaveCount(0);
    await expect(userB.getByTestId('ticket-card')).toHaveCount(0);

    await userB.goto(`/tickets/${world.ticketId}`);
    await expect(userB.getByText('找不到这张机票')).toBeVisible();
    await expect(userB.getByText(world.ticketNo)).toHaveCount(0);

    const userA = chat();
    await userA.getByRole('link', { name: '历史对话', exact: true }).click();
    await expect(userA.getByRole('heading', { name: '历史对话' })).toBeVisible();
    await expect(userA.getByText(FLIGHT).first()).toBeVisible();
    await expect(userA.locator(`a[href="/chat/${sessionB}"]`)).toHaveCount(0);
    await userA.goto(`/chat/${sessionB}`);
    await expect(userA.getByText('找不到这个对话')).toBeVisible();
    await userA.getByRole('link', { name: '我的机票', exact: true }).click();
    await expect(userA.getByTestId('ticket-item')).toHaveCount(1);
    await expect(userA.getByText(world.ticketNo)).toBeVisible();
  } finally {
    await other.close();
  }
});
