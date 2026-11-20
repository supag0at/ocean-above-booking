// In-memory fake backend state for MSW. This stands in for gateway + agent + booking: the numbers below are
// hard-coded fixtures (the real values come from flight-core), NOT computed here.
import type {
  MemoryView,
  PublicEphemeral,
  PublicEvent,
  Quote,
  SessionStatus,
  SessionView,
  TicketView,
  UserView,
} from '@fb/contracts/web';

const LOCATIONS_DB_SHA256 = 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f';

interface Route {
  from: string;
  to: string;
  legs: Array<[string, string, number]>;
  transferCities: string[];
  totalDistanceKm: number;
  priceCents: number;
  display: { legs: string[]; totalDistanceKm: string; priceUsd: string };
}

// Both "San Jose" and "San José" exist on purpose (A-01 §9.7): the UI must never merge them.
export const ROUTES: Record<'direct' | 'transfer', Route> = {
  direct: {
    from: 'San Jose',
    to: 'Tokyo',
    legs: [['San Jose', 'Tokyo', 8280.25]],
    transferCities: [],
    totalDistanceKm: 8280.25,
    priceCents: 107643,
    display: { legs: ['8280.25'], totalDistanceKm: '8280.25', priceUsd: '1076.43' },
  },
  transfer: {
    from: 'San José',
    to: 'Reykjavik',
    legs: [
      ['San José', 'London', 8000.1],
      ['London', 'Reykjavik', 1900.55],
    ],
    transferCities: ['London'],
    totalDistanceKm: 9900.65,
    priceCents: 128708,
    display: { legs: ['8000.10', '1900.55'], totalDistanceKm: '9900.65', priceUsd: '1287.08' },
  },
};

export type FrameListener = (
  frame:
    | { kind: 'evt'; event: PublicEvent }
    | { kind: 'eph'; eph: PublicEphemeral }
    | { kind: 'status'; status: SessionStatus },
) => void;

interface SessionRec {
  view: SessionView;
  events: PublicEvent[];
  listeners: Set<FrameListener>;
}

export interface MockStore {
  user: UserView | null;
  sessions: Map<string, SessionRec>;
  quotes: Map<string, { sessionId: string; quote: Quote; ticketId: string | null }>;
  tickets: TicketView[];
  memories: MemoryView[];
  /** quoteIds that already failed once with 503 (the demo transfer quote needs a second look). */
  flaky: Set<string>;
  counter: number;
}

const iso = (offsetMin: number) => new Date(Date.UTC(2026, 10, 19, 8, 0) + offsetMin * 60_000).toISOString();

export function nextId(store: MockStore, prefix: string): string {
  store.counter += 1;
  return `${prefix}_${store.counter.toString(36).padStart(4, '0')}`;
}

export function makeQuote(store: MockStore, route: Route): Quote {
  return {
    quoteId: nextId(store, 'q'),
    from: route.from,
    to: route.to,
    legs: route.legs.map(([from, to, distanceKm]) => ({ from, to, distanceKm })),
    transferCities: [...route.transferCities],
    totalDistanceKm: route.totalDistanceKm,
    priceCents: route.priceCents,
    display: {
      legs: [...route.display.legs],
      totalDistanceKm: route.display.totalDistanceKm,
      priceUsd: route.display.priceUsd,
    },
    dataSha256: LOCATIONS_DB_SHA256,
    createdAt: new Date().toISOString(),
  };
}

export function emit(store: MockStore, sessionId: string, build: (seq: number) => PublicEvent): PublicEvent {
  const rec = store.sessions.get(sessionId)!;
  const seq = (rec.events[rec.events.length - 1]?.seq ?? 0) + 1;
  const event = build(seq);
  rec.events.push(event);
  rec.view.lastSeq = seq;
  rec.view.updatedAt = new Date().toISOString();
  rec.listeners.forEach((l) => l({ kind: 'evt', event }));
  return event;
}

export function emitEph(store: MockStore, sessionId: string, eph: PublicEphemeral) {
  store.sessions.get(sessionId)?.listeners.forEach((l) => l({ kind: 'eph', eph }));
}

export function setStatus(store: MockStore, sessionId: string, status: SessionStatus) {
  const rec = store.sessions.get(sessionId);
  if (!rec) return;
  rec.view.status = status;
  rec.listeners.forEach((l) => l({ kind: 'status', status }));
}

export function bookQuote(store: MockStore, quoteId: string): TicketView {
  const q = store.quotes.get(quoteId)!;
  const ticketId = nextId(store, 't');
  const ticket: TicketView = {
    ticketId,
    ticketNo: `OA${String(store.counter).padStart(6, '0')}`,
    sessionId: q.sessionId,
    quoteId,
    from: q.quote.from,
    to: q.quote.to,
    itinerary: q.quote,
    priceCents: q.quote.priceCents,
    bookedAt: new Date().toISOString(),
  };
  store.tickets.unshift(ticket);
  q.ticketId = ticketId;
  // booking.confirmed is written by the gateway (M-21); the agent says nothing afterwards (D-39).
  emit(store, q.sessionId, (seq) => ({
    seq,
    type: 'booking.confirmed',
    actor: 'system',
    ts: new Date().toISOString(),
    payload: { quoteId, ticketId, ticketNo: ticket.ticketNo },
  }));
  return ticket;
}

/** A finished, booked conversation plus a couple of remembered preferences, so every page has content. */
export function createStore(): MockStore {
  const store: MockStore = {
    user: null,
    sessions: new Map(),
    quotes: new Map(),
    tickets: [],
    memories: [],
    flaky: new Set(),
    counter: 0,
  };
  const sid = 'sess_history';
  store.sessions.set(sid, {
    view: {
      id: sid,
      title: 'San Jose → Tokyo',
      locale: 'zh',
      status: 'idle',
      lastSeq: 0,
      createdAt: iso(-120),
      updatedAt: iso(-100),
    },
    events: [],
    listeners: new Set(),
  });
  const quote = makeQuote(store, ROUTES.direct);
  quote.createdAt = iso(-105);
  store.quotes.set(quote.quoteId, { sessionId: sid, quote, ticketId: null });
  const ts = (m: number) => iso(m);
  let n = 0;
  const push = (e: Omit<PublicEvent, 'seq'> & { seq?: number }) => {
    n += 1;
    const rec = store.sessions.get(sid)!;
    rec.events.push({ ...e, seq: n } as PublicEvent);
    rec.view.lastSeq = n;
  };
  const run = 'run_hist1';
  push({
    type: 'user.message',
    actor: 'user',
    ts: ts(-119),
    payload: { text: '我想从 San Jose 飞到 Tokyo', clientMessageId: '11111111-1111-4111-8111-111111111111' },
  });
  push({ type: 'agent.run_started', actor: 'agent', ts: ts(-119), payload: { runId: run } });
  push({
    type: 'agent.message',
    actor: 'agent',
    ts: ts(-118),
    payload: { runId: run, messageKey: 'm1', kind: 'process', processText: '先确认出发地和目的地，再查询航线。' },
  });
  push({
    type: 'agent.message',
    actor: 'agent',
    ts: ts(-118),
    payload: { runId: run, messageKey: 'tr:1', toolCallId: 'c1', toolName: 'resolve_city', isError: false },
  });
  push({
    type: 'agent.message',
    actor: 'agent',
    ts: ts(-117),
    payload: { runId: run, messageKey: 'tr:2', toolCallId: 'c2', toolName: 'quote_route', isError: false },
  });
  push({ type: 'quote.offered', actor: 'agent', ts: ts(-117), payload: { quoteId: quote.quoteId } });
  push({
    type: 'agent.message',
    actor: 'agent',
    ts: ts(-116),
    payload: {
      runId: run,
      messageKey: 'm2',
      kind: 'reply',
      text: '为你找到一条直飞航线，详见下方**报价卡**。更多信息：[官网](javascript:alert(1)) <script>alert(1)</script>',
    },
  });
  push({ type: 'agent.run_completed', actor: 'agent', ts: ts(-116), payload: { runId: run } });
  const ticket = bookQuote(store, quote.quoteId);
  ticket.bookedAt = ts(-100);

  store.memories = [
    {
      memoryId: 'm_0001',
      key: 'home_city',
      value: 'San José',
      createdAt: ts(-119),
      source: { sessionId: sid, seq: 1 },
    },
    {
      memoryId: 'm_0002',
      key: 'preferred_language',
      value: 'zh',
      createdAt: ts(-119),
      source: { sessionId: sid, seq: 1 },
    },
  ];
  return store;
}
