// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { QuoteView } from '@fb/contracts/web';
import { initI18n } from '../i18n/index.ts';
import { createHandlers } from '../mocks/handlers.ts';
import { ROUTES, createStore, makeQuote, type MockStore } from '../mocks/store.ts';
import { SafeMarkdown } from './SafeMarkdown.tsx';
import { ProcessArea } from './ProcessArea.tsx';
import { QuoteCard } from './QuoteCard.tsx';
import type { TimelineItem } from '../chat/state.ts';

let store: MockStore;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());
beforeEach(async () => {
  initI18n('zh');
  store = createStore();
  store.user = { id: 'u1', username: 'alice', locale: 'zh' };
  document.cookie = 'fb_csrf=testcsrf; path=/';
  server.resetHandlers(...createHandlers(store, { speed: 0 }).handlers);
});
afterEach(() => cleanup());

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

function addQuote(route: 'direct' | 'transfer' = 'direct') {
  const quote = makeQuote(store, ROUTES[route]);
  store.quotes.set(quote.quoteId, { sessionId: 'sess_history', quote, ticketId: null });
  return quote;
}

describe('SafeMarkdown (XSS, D-25)', () => {
  it('does not execute or render <script>, raw HTML, or images', () => {
    (window as unknown as { __pwned?: boolean }).__pwned = false;
    const { container } = render(
      <SafeMarkdown
        text={
          'hello <script>window.__pwned = true</script> <img src=x onerror="window.__pwned=true"> ![pic](http://x/y.png) <b onclick="1">bold</b>'
        }
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('[onerror],[onclick]')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBe(false);
  });

  it('renders links, including javascript: ones, as plain text (never an anchor)', () => {
    const { container } = render(
      <SafeMarkdown text={'[click me](javascript:alert(1)) and [site](https://example.com) <https://auto.link>'} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click me');
    expect(container.textContent).toContain('site');
    expect(container.textContent).toContain('https://example.com');
  });

  it('still renders ordinary markdown', () => {
    const { container } = render(<SafeMarkdown text={'**bold** text'} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });
});

describe('QuoteCard (H-01, D-06)', () => {
  it('shows only API data: display strings, route, transfer note', async () => {
    const q = addQuote('transfer');
    wrap(<QuoteCard quoteId={q.quoteId} booked={null} failedCode={null} />);
    await screen.findByTestId('quote-card');
    expect(screen.getByTestId('route-line').textContent).toBe('San José → London → Reykjavik');
    expect(screen.getByTestId('transfer-note').textContent).toBe('在 London 换乘');
    expect(screen.getByTestId('total-distance').textContent).toBe('9900.65 km');
    expect(screen.getByTestId('price').textContent).toBe('1287.08 USD');
    expect(screen.getAllByTestId('leg').map((l) => l.textContent)).toEqual([
      'San José → London8000.10 km',
      'London → Reykjavik1900.55 km',
    ]);
    expect(screen.getByText(/只有点击此按钮才会出票/)).toBeTruthy();
  });

  it('does not use any figure from surrounding LLM text: server display drives the card', async () => {
    const q = addQuote('direct');
    // The API returns whatever display it likes; the card must echo it, not recompute or reformat.
    server.use(
      http.get('*/api/v1/quotes/:id', () => {
        const view: QuoteView = {
          sessionId: 's',
          quote: { ...q, display: { legs: ['A'], totalDistanceKm: 'DISPLAY-KM', priceUsd: 'DISPLAY-USD' } },
          booking: { status: 'available' },
        };
        return HttpResponse.json({ quote: view });
      }),
    );
    wrap(
      <div>
        <p>LLM says the price is 1.23 USD and distance 4.56 km</p>
        <QuoteCard quoteId={q.quoteId} booked={null} failedCode={null} />
      </div>,
    );
    await screen.findByTestId('quote-card');
    expect(screen.getByTestId('price').textContent).toBe('DISPLAY-USD USD');
    expect(screen.getByTestId('total-distance').textContent).toBe('DISPLAY-KM km');
  });

  it('direct flight shows "直飞"', async () => {
    const q = addQuote('direct');
    wrap(<QuoteCard quoteId={q.quoteId} booked={null} failedCode={null} />);
    await screen.findByTestId('quote-card');
    expect(screen.getByTestId('transfer-note').textContent).toBe('直飞');
  });

  it('confirm is the only order action: one click POSTs with no body and no Content-Type, then shows the ticket no.', async () => {
    const q = addQuote('direct');
    let seen: { contentType: string | null; csrf: string | null; body: string } | null = null;
    server.use(
      http.post('*/api/v1/quotes/:id/confirm', async ({ request }) => {
        seen = {
          contentType: request.headers.get('content-type'),
          csrf: request.headers.get('x-csrf-token'),
          body: await request.text(),
        };
        return undefined; // fall through to the mock handler
      }),
    );
    wrap(<QuoteCard quoteId={q.quoteId} booked={null} failedCode={null} />);
    const btn = await screen.findByTestId('confirm-button');
    fireEvent.click(btn);
    await screen.findByTestId('booked-state');
    expect(seen).toEqual({ contentType: null, csrf: 'testcsrf', body: '' });
    expect(screen.queryByTestId('confirm-button')).toBeNull();
    expect(screen.getByTestId('booked-state').textContent).toMatch(/OA\d+/);
  });

  it('503 shows "confirming" and polls until the quote becomes booked (§9.3)', async () => {
    const q = addQuote('transfer');
    wrap(<QuoteCard quoteId={q.quoteId} booked={null} failedCode={null} />);
    fireEvent.click(await screen.findByTestId('confirm-button'));
    await screen.findByRole('status'); // BOOKING_UNAVAILABLE hint while polling
    expect((screen.getByTestId('confirm-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders booking.failed as a localized error and keeps the button usable (retry)', async () => {
    const q = addQuote('direct');
    wrap(<QuoteCard quoteId={q.quoteId} booked={null} failedCode="QUOTE_NOT_OFFERED" />);
    const err = await screen.findByTestId('quote-error');
    expect(err.textContent).toBe('这个报价尚未在对话中出示，无法下单');
    expect((screen.getByTestId('confirm-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ProcessArea folding (A-01 §9.4.1)', () => {
  const base = {
    kind: 'run',
    key: 'run:r',
    runId: 'r',
    steps: [
      { kind: 'text', key: 'p:1', text: 'step one' },
      { kind: 'tool', key: 't:1', toolName: 'quote_route', isError: false },
    ],
    processCount: 1,
  } as const;
  const live = {
    reasoning: [{ messageKey: 'm', text: 'pondering' }],
    deltas: [{ messageKey: 'd', text: 'streaming text' }],
    tools: [{ toolCallId: 'x', name: 'resolve_city', phase: 'start' as const, isError: false }],
  };
  const item = (o: Partial<Extract<TimelineItem, { kind: 'run' }>>) =>
    ({ ...base, finished: false, live: null, ...o }) as Extract<TimelineItem, { kind: 'run' }>;

  it('is expanded while running, shows live content and the disclaimer', () => {
    render(<ProcessArea run={item({ live })} />);
    const area = screen.getByTestId('process-area');
    expect(area.getAttribute('data-expanded')).toBe('true');
    expect(area.textContent).toContain('中间过程，不作为报价依据');
    expect(area.textContent).toContain('pondering');
    expect(area.textContent).toContain('streaming text');
    expect(area.textContent).toContain('正在识别城市…');
  });

  it('is collapsed once finished: header with N and disclaimer stay, body hidden, user can expand', () => {
    render(<ProcessArea run={item({ finished: true })} />);
    const area = screen.getByTestId('process-area');
    expect(area.getAttribute('data-expanded')).toBe('false');
    expect(area.textContent).toContain('思考过程（1 步）');
    expect(area.textContent).toContain('中间过程，不作为报价依据');
    expect(area.textContent).not.toContain('step one');
    fireEvent.click(screen.getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('process-area').textContent).toContain('step one');
    expect(screen.getByTestId('process-area').textContent).toContain('✓ 已查询航线');
  });

  it('collapses by itself when the run finishes, dropping the live content', () => {
    const { rerender } = render(<ProcessArea run={item({ live })} />);
    expect(screen.getByTestId('process-area').getAttribute('data-expanded')).toBe('true');
    rerender(<ProcessArea run={item({ finished: true, live: null })} />);
    const area = screen.getByTestId('process-area');
    expect(area.getAttribute('data-expanded')).toBe('false');
    expect(area.textContent).not.toContain('pondering');
  });

  it('renders text as plain text: no markup, no links', () => {
    const { container } = render(
      <ProcessArea
        run={item({
          live: {
            reasoning: [],
            deltas: [{ messageKey: 'd', text: '<b>x</b> [l](http://e.com) <script>1</script>' }],
            tools: [],
          },
        })}
      />,
    );
    expect(container.querySelector('b,a,script')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
  });

  it('renders nothing for a finished run with no process steps (N = 0)', () => {
    const { container } = render(<ProcessArea run={item({ finished: true, processCount: 0, steps: [] })} />);
    expect(container.innerHTML).toBe('');
  });

  it('never contains quote cards or the confirm button', () => {
    render(<ProcessArea run={item({ live })} />);
    expect(screen.queryByTestId('confirm-button')).toBeNull();
    expect(screen.queryByTestId('quote-card')).toBeNull();
  });
});

describe('language switching', () => {
  it('switches copy between zh and en', () => {
    const q = addQuote();
    wrap(<QuoteCard quoteId={q.quoteId} booked={null} failedCode={null} />);
    return screen.findByText('确认下单').then(async () => {
      initI18n('en');
      await screen.findByText('Confirm booking');
      initI18n('zh');
      await waitFor(() => expect(screen.getByText('确认下单')).toBeTruthy());
    });
  });
});
