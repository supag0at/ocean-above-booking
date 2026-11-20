// MSW handlers for the public API (A-01 §4.3) and the SSE stream (§4.4). Every response body is checked against
// the @fb/contracts/web schema before it is sent; a violation turns into a 500 so dev and tests fail loudly.
import { HttpResponse, http, sse } from 'msw';
import {
  ApiErrorSchema,
  ConfirmCreatedResponseSchema,
  ConfirmReplayResponseSchema,
  CreateSessionBodySchema,
  EventsResponseSchema,
  LoginBodySchema,
  PatchMeBodySchema,
  PostMessageBodySchema,
  ProfileResponseSchema,
  PublicEphemeralSchema,
  PublicEventSchema,
  QuoteResponseSchema,
  SessionResponseSchema,
  SessionsPageSchema,
  StatusFrameSchema,
  TicketResponseSchema,
  TicketsPageSchema,
  UserResponseSchema,
  type ErrorCode,
  type Locale,
  type PublicEvent,
} from '@fb/contracts/web';
import {
  ROUTES,
  bookQuote,
  createStore,
  emit,
  emitEph,
  makeQuote,
  nextId,
  setStatus,
  type MockStore,
} from './store.ts';
import { assertSchema, matchesSchema } from './validate.ts';

const P = '*/api/v1';

function fail(status: number, code: ErrorCode, message = 'mock error') {
  const body = assertSchema(ApiErrorSchema, { error: { code, message, traceId: 'mock-trace' } }, 'error');
  return HttpResponse.json(body, { status });
}

function cookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? m.slice(name.length + 1) : null;
}

/** A-01 §4.2: writes need X-CSRF-Token == fb_csrf; body-less writes must carry no Content-Type. */
function csrfProblem(request: Request, bodyless: boolean) {
  if (request.headers.get('x-csrf-token') !== cookie('fb_csrf')) return fail(403, 'CSRF_INVALID');
  if (bodyless && request.headers.has('content-type'))
    return fail(400, 'VALIDATION_FAILED', 'body-less request must not send Content-Type');
  return null;
}

const ACCENTED_E = String.fromCharCode(0xe9);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

export interface MockOptions {
  /** Delay scale for the scripted agent run (1 = demo speed, 0 = instant, for tests). */
  speed?: number;
}

export function createHandlers(store: MockStore = createStore(), opts: MockOptions = {}) {
  const speed = opts.speed ?? 1;
  const pause = (ms: number) => wait(ms * speed);

  const guard = (res: () => Response) => {
    try {
      return res();
    } catch (e) {
      console.error(e);
      return HttpResponse.json({ error: 'mock contract violation', detail: String(e) }, { status: 500 });
    }
  };
  const authed = (): boolean => store.user !== null;

  /** Scripted stand-in for the agent run: reasoning + deltas + tool steps + quote + guarded reply. */
  async function runAgent(sessionId: string, text: string) {
    const rec = store.sessions.get(sessionId)!;
    const zh = rec.view.locale === 'zh';
    const runId = nextId(store, 'run');
    const ts = () => now();
    const key = (n: number) => `${runId}:m${n}`;
    const stream = async (messageKey: string, textValue: string, kind: 'agent.delta' | 'agent.reasoning_delta') => {
      for (const chunk of textValue.match(/.{1,6}/gu) ?? []) {
        emitEph(
          store,
          sessionId,
          assertSchema(PublicEphemeralSchema, { type: kind, payload: { runId, messageKey, textDelta: chunk } }, 'eph'),
        );
        await pause(60);
      }
    };
    const tool = async (callId: string, name: string) => {
      emitEph(store, sessionId, {
        type: 'agent.tool_status',
        payload: { runId, toolCallId: callId, name, phase: 'start' },
      });
      await pause(700);
      emitEph(store, sessionId, {
        type: 'agent.tool_status',
        payload: { runId, toolCallId: callId, name, phase: 'end', isError: false },
      });
      emit(store, sessionId, (seq) => ({
        seq,
        type: 'agent.message',
        actor: 'agent',
        ts: ts(),
        payload: { runId, messageKey: `tr:${runId}:${callId}`, toolCallId: callId, toolName: name, isError: false },
      }));
    };

    setStatus(store, sessionId, 'running');
    emit(store, sessionId, (seq) => ({ seq, type: 'agent.run_started', actor: 'agent', ts: ts(), payload: { runId } }));
    await pause(300);
    await stream(
      key(0),
      zh
        ? '用户想订机票，需要先确认出发地和目的地，再查航线。'
        : 'The user wants a flight. Resolve both cities first, then look up the route.',
      'agent.reasoning_delta',
    );

    const thought1 = zh ? '先确认城市。' : 'Resolving the cities first.';
    await stream(key(1), thought1, 'agent.delta');
    emit(store, sessionId, (seq) => ({
      seq,
      type: 'agent.message',
      actor: 'agent',
      ts: ts(),
      payload: { runId, messageKey: key(1), kind: 'process', processText: thought1 },
    }));
    await tool(`${runId}-c1`, 'resolve_city');

    const thought2 = zh ? '再查询最短航线并出示报价。' : 'Now find the shortest route and offer a quote.';
    await stream(key(2), thought2, 'agent.delta');
    emit(store, sessionId, (seq) => ({
      seq,
      type: 'agent.message',
      actor: 'agent',
      ts: ts(),
      payload: { runId, messageKey: key(2), kind: 'process', processText: thought2 },
    }));
    await tool(`${runId}-c2`, 'quote_route');
    await tool(`${runId}-c3`, 'offer_booking');

    // "San José" (accented) -> the transfer route; plain "San Jose" -> the direct one
    const route = text.normalize('NFC').includes(ACCENTED_E) ? ROUTES.transfer : ROUTES.direct;
    const quote = makeQuote(store, route);
    store.quotes.set(quote.quoteId, { sessionId, quote, ticketId: null });
    emit(store, sessionId, (seq) => ({
      seq,
      type: 'quote.offered',
      actor: 'agent',
      ts: ts(),
      payload: { quoteId: quote.quoteId },
    }));

    // The final reply deliberately contains no figures: the quote card is the only authority (H-01).
    const reply = zh
      ? `已为你找到 **${quote.from} → ${quote.to}** 的航线，具体航程和价格请看上方报价卡。确认无误后点击“确认下单”即可。`
      : `I found a route **${quote.from} → ${quote.to}**. See the quote card above for the itinerary and price, and click “Confirm booking” if it looks right.`;
    await stream(key(3), reply, 'agent.delta');
    emit(store, sessionId, (seq) => ({
      seq,
      type: 'agent.message',
      actor: 'agent',
      ts: ts(),
      payload: { runId, messageKey: key(3), kind: 'reply', text: reply },
    }));
    emit(store, sessionId, (seq) => ({
      seq,
      type: 'agent.run_completed',
      actor: 'agent',
      ts: ts(),
      payload: { runId },
    }));
    setStatus(store, sessionId, 'idle');
  }

  const streamHandler = () =>
    sse<{ evt: string; eph: string; status: string }>(`${P}/sessions/:id/stream`, ({ client, params, request }) => {
      const rec = store.sessions.get(String(params['id']));
      if (!rec || !authed()) {
        client.close();
        return;
      }
      const url = new URL(request.url);
      const after = Number(request.headers.get('last-event-id') ?? url.searchParams.get('afterSeq') ?? '0');
      const sendEvt = (event: PublicEvent) => {
        assertSchema(PublicEventSchema, event, 'sse evt');
        client.send({ event: 'evt', id: String(event.seq), data: JSON.stringify(event) });
      };
      for (const e of rec.events) if (e.seq > after) sendEvt(e);
      const listener: Parameters<typeof rec.listeners.add>[0] = (frame) => {
        if (frame.kind === 'evt') sendEvt(frame.event);
        else if (frame.kind === 'eph')
          client.send({
            event: 'eph',
            data: JSON.stringify(assertSchema(PublicEphemeralSchema, frame.eph, 'sse eph')),
          });
        else
          client.send({
            event: 'status',
            data: JSON.stringify(assertSchema(StatusFrameSchema, { status: frame.status }, 'sse status')),
          });
      };
      rec.listeners.add(listener);
      request.signal.addEventListener('abort', () => rec.listeners.delete(listener));
    });

  const handlers = [
    // MSW's sse() needs an EventSource global (absent in jsdom component tests, which never open the stream)
    ...(typeof EventSource === 'undefined' ? [] : [streamHandler()]),
    http.post(`${P}/auth/login`, async ({ request }) => {
      const body = await request.json().catch(() => null);
      if (!matchesSchema(LoginBodySchema, body)) return fail(400, 'VALIDATION_FAILED');
      const name = (body as { username: string }).username.normalize('NFKC').trim().toLowerCase();
      if (name.length < 1 || name.length > 32) return fail(400, 'VALIDATION_FAILED');
      store.user = { id: `u_${name}`, username: name, locale: 'zh' };
      if (typeof document !== 'undefined') document.cookie = `fb_csrf=mockcsrf${nextId(store, 'x')}; path=/`;
      return guard(() => HttpResponse.json(assertSchema(UserResponseSchema, { user: store.user! }, 'login')));
    }),
    http.post(`${P}/auth/logout`, ({ request }) => {
      const bad = csrfProblem(request, true);
      if (bad) return bad;
      store.user = null;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${P}/me`, () => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      return guard(() => HttpResponse.json(assertSchema(UserResponseSchema, { user: store.user! }, 'me')));
    }),
    http.patch(`${P}/me`, async ({ request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const bad = csrfProblem(request, false);
      if (bad) return bad;
      const body = await request.json().catch(() => null);
      if (!matchesSchema(PatchMeBodySchema, body)) return fail(400, 'VALIDATION_FAILED');
      store.user = { ...store.user!, locale: (body as { locale: Locale }).locale };
      return guard(() => HttpResponse.json(assertSchema(UserResponseSchema, { user: store.user! }, 'patch me')));
    }),

    http.get(`${P}/sessions`, () => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const items = [...store.sessions.values()]
        .map((s) => s.view)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return guard(() => HttpResponse.json(assertSchema(SessionsPageSchema, { items }, 'sessions')));
    }),
    http.post(`${P}/sessions`, async ({ request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const bad = csrfProblem(request, false);
      if (bad) return bad;
      const body = await request.json().catch(() => null);
      if (!matchesSchema(CreateSessionBodySchema, body)) return fail(400, 'VALIDATION_FAILED');
      const id = nextId(store, 'sess');
      const view = {
        id,
        title: null,
        locale: (body as { locale?: Locale }).locale ?? 'zh',
        status: 'idle' as const,
        lastSeq: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      store.sessions.set(id, { view, events: [], listeners: new Set() });
      return guard(() =>
        HttpResponse.json(assertSchema(SessionResponseSchema, { session: view }, 'session'), { status: 201 }),
      );
    }),
    http.get(`${P}/sessions/:id`, ({ params }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const rec = store.sessions.get(String(params['id']));
      if (!rec) return fail(404, 'SESSION_NOT_FOUND');
      return guard(() => HttpResponse.json(assertSchema(SessionResponseSchema, { session: rec.view }, 'session')));
    }),
    http.get(`${P}/sessions/:id/events`, ({ params, request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const rec = store.sessions.get(String(params['id']));
      if (!rec) return fail(404, 'SESSION_NOT_FOUND');
      const after = Number(new URL(request.url).searchParams.get('afterSeq') ?? '0');
      const events = rec.events.filter((e) => e.seq > after).slice(0, 200);
      return guard(() => HttpResponse.json(assertSchema(EventsResponseSchema, { events, hasMore: false }, 'events')));
    }),
    http.post(`${P}/sessions/:id/messages`, async ({ params, request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const bad = csrfProblem(request, false);
      if (bad) return bad;
      const id = String(params['id']);
      const rec = store.sessions.get(id);
      if (!rec) return fail(404, 'SESSION_NOT_FOUND');
      const body = await request.json().catch(() => null);
      if (!matchesSchema(PostMessageBodySchema, body)) return fail(400, 'VALIDATION_FAILED');
      const { text, clientMessageId } = body as { text: string; clientMessageId: string };
      const dup = rec.events.find((e) => e.type === 'user.message' && e.payload.clientMessageId === clientMessageId);
      if (dup && dup.type === 'user.message') {
        if (dup.payload.text !== text) return fail(409, 'IDEMPOTENCY_CONFLICT');
        return guard(() => HttpResponse.json({ event: dup }, { status: 200 }));
      }
      const event = emit(store, id, (seq) => ({
        seq,
        type: 'user.message',
        actor: 'user',
        ts: now(),
        payload: { text, clientMessageId },
      }));
      if (rec.view.title === null) rec.view.title = text.slice(0, 40);
      void runAgent(id, text);
      return guard(() =>
        HttpResponse.json({ event: assertSchema(PublicEventSchema, event, 'post message') }, { status: 202 }),
      );
    }),

    http.get(`${P}/quotes/:quoteId`, ({ params }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const q = store.quotes.get(String(params['quoteId']));
      if (!q) return fail(404, 'QUOTE_NOT_FOUND');
      const t = q.ticketId ? store.tickets.find((x) => x.ticketId === q.ticketId) : undefined;
      const booking = t
        ? { status: 'booked' as const, ticketId: t.ticketId, ticketNo: t.ticketNo }
        : { status: 'available' as const };
      return guard(() =>
        HttpResponse.json(
          assertSchema(QuoteResponseSchema, { quote: { sessionId: q.sessionId, quote: q.quote, booking } }, 'quote'),
        ),
      );
    }),
    http.post(`${P}/quotes/:quoteId/confirm`, ({ params, request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const bad = csrfProblem(request, true);
      if (bad) return bad;
      const quoteId = String(params['quoteId']);
      const q = store.quotes.get(quoteId);
      if (!q) return fail(404, 'QUOTE_NOT_FOUND');
      const existing = q.ticketId ? store.tickets.find((x) => x.ticketId === q.ticketId) : undefined;
      if (existing)
        return guard(() =>
          HttpResponse.json(
            assertSchema(ConfirmReplayResponseSchema, { ticket: existing, alreadyBooked: true }, 'confirm replay'),
            { status: 200 },
          ),
        );
      // Demo of §9.3's 503 path: the transfer quote's first confirm times out, but booking finishes in the background.
      if (q.quote.transferCities.length > 0 && !store.flaky.has(quoteId)) {
        store.flaky.add(quoteId);
        setTimeout(() => bookQuote(store, quoteId), 4000 * speed);
        return fail(503, 'BOOKING_UNAVAILABLE');
      }
      const ticket = bookQuote(store, quoteId);
      return guard(() =>
        HttpResponse.json(assertSchema(ConfirmCreatedResponseSchema, { ticket }, 'confirm'), { status: 201 }),
      );
    }),

    http.get(`${P}/tickets`, () => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      return guard(() => HttpResponse.json(assertSchema(TicketsPageSchema, { items: store.tickets }, 'tickets')));
    }),
    http.get(`${P}/tickets/:ticketId`, ({ params }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const t = store.tickets.find((x) => x.ticketId === params['ticketId']);
      if (!t) return fail(404, 'TICKET_NOT_FOUND');
      return guard(() => HttpResponse.json(assertSchema(TicketResponseSchema, { ticket: t }, 'ticket')));
    }),

    http.get(`${P}/profile`, () => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      return guard(() =>
        HttpResponse.json(assertSchema(ProfileResponseSchema, { preferences: store.memories }, 'profile')),
      );
    }),
    http.delete(`${P}/profile/memories/:memoryId`, ({ params, request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const bad = csrfProblem(request, true);
      if (bad) return bad;
      store.memories = store.memories.filter((m) => m.memoryId !== params['memoryId']);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${P}/profile/memories`, ({ request }) => {
      if (!authed()) return fail(401, 'AUTH_REQUIRED');
      const bad = csrfProblem(request, true);
      if (bad) return bad;
      store.memories = [];
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${P}/healthz`, () => HttpResponse.json({ ok: true })),
  ];
  return { handlers, store };
}
