// Thin fetch wrapper for the public API (A-01 §4). The browser never sends userId (H-04); identity is the
// HttpOnly fb_sid cookie. Writes carry X-CSRF-Token read from the non-HttpOnly fb_csrf cookie (§4.2).
import {
  API_PREFIX,
  type ConfirmCreatedResponse,
  type ConfirmReplayResponse,
  type ErrorCode,
  type EventsResponse,
  type Locale,
  type MemoryView,
  type PostMessageResponse,
  type QuoteView,
  type SessionView,
  type SessionsPage,
  type TicketView,
  type TicketsPage,
  type UserView,
} from '@fb/contracts/web';

/** Error with a server `code` (or a client-side `NETWORK` / `UNKNOWN` marker). UI text comes from i18n by code. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK' | 'UNKNOWN';
  constructor(status: number, code: ErrorCode | 'NETWORK' | 'UNKNOWN', message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
/** Registered once by the app shell: any 401 sends the user to /login. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

function readCookie(name: string): string | null {
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body. When absent, NO body and NO Content-Type header is sent (§4.2, O-3). */
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<{ status: number; data: T }> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (opts.signal) init.signal = opts.signal;
  if (method !== 'GET') {
    const csrf = readCookie('fb_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    // absolute URL so the same code runs in the browser and under Node's fetch (tests)
    res = await fetch(new URL(`${API_PREFIX}${path}`, window.location.href).href, init);
  } catch {
    throw new ApiRequestError(0, 'NETWORK', 'network error');
  }
  if (res.status === 204) return { status: 204, data: undefined as T };
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: ErrorCode; message?: string } } | null)?.error;
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiRequestError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? `HTTP ${res.status}`);
  }
  return { status: res.status, data: json as T };
}

const get = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
  (await request<T>(path, signal ? { signal } : {})).data;

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  login: async (username: string) =>
    (await request<{ user: UserView }>('/auth/login', { method: 'POST', body: { username } })).data.user,
  logout: async () => {
    await request<void>('/auth/logout', { method: 'POST' });
  },
  me: async () => (await get<{ user: UserView }>('/me')).user,
  setLocale: async (locale: Locale) =>
    (await request<{ user: UserView }>('/me', { method: 'PATCH', body: { locale } })).data.user,

  listSessions: (cursor?: string) => get<SessionsPage>(`/sessions${qs({ cursor, limit: 30 })}`),
  createSession: async (locale: Locale) =>
    (await request<{ session: SessionView }>('/sessions', { method: 'POST', body: { locale } })).data.session,
  getSession: async (id: string) =>
    (await get<{ session: SessionView }>(`/sessions/${encodeURIComponent(id)}`)).session,
  listEvents: (id: string, afterSeq: number, signal?: AbortSignal) =>
    get<EventsResponse>(`/sessions/${encodeURIComponent(id)}/events${qs({ afterSeq, limit: 200 })}`, signal),
  postMessage: async (id: string, text: string, clientMessageId: string) =>
    (
      await request<PostMessageResponse>(`/sessions/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        body: { text, clientMessageId },
      })
    ).data.event,

  getQuote: async (quoteId: string) =>
    (await get<{ quote: QuoteView }>(`/quotes/${encodeURIComponent(quoteId)}`)).quote,
  /** The ONLY order entry point (D-06). No body, no Content-Type. */
  confirmQuote: async (quoteId: string): Promise<TicketView> => {
    const { data } = await request<ConfirmCreatedResponse | ConfirmReplayResponse>(
      `/quotes/${encodeURIComponent(quoteId)}/confirm`,
      { method: 'POST' },
    );
    return data.ticket;
  },

  listTickets: (cursor?: string) => get<TicketsPage>(`/tickets${qs({ cursor, limit: 30 })}`),
  getTicket: async (ticketId: string) =>
    (await get<{ ticket: TicketView }>(`/tickets/${encodeURIComponent(ticketId)}`)).ticket,

  getProfile: async (): Promise<MemoryView[]> => (await get<{ preferences: MemoryView[] }>('/profile')).preferences,
  deleteMemory: async (memoryId: string) => {
    await request<void>(`/profile/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
  },
  deleteAllMemories: async () => {
    await request<void>('/profile/memories', { method: 'DELETE' });
  },
};
