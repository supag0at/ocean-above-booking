// Session event stream (A-01 §9.5): REST history first, then one EventSource per open session.
// - events are de-duplicated by seq in the reducer; a seq gap triggers a REST catch-up (§4.4)
// - the browser reconnects by itself (retry: 3000) and sends Last-Event-ID; ephemeral content missed while
//   disconnected is not replayed
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  API_PREFIX,
  SSE_EVENT_NAMES,
  type PublicEphemeral,
  type PublicEvent,
  type SessionStatus,
  type StatusFrame,
} from '@fb/contracts/web';
import { api } from '../api/client.ts';
import { chatReducer, initialChatState, maxSeq, type ChatState } from './state.ts';

export interface EventSourceLike {
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void;
  close(): void;
  readonly readyState: number;
}
export type EventSourceFactory = (url: string) => EventSourceLike;
const defaultFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

export interface SessionStream {
  state: ChatState;
  loading: boolean;
  error: unknown;
  send: (text: string) => Promise<void>;
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function useSessionStream(
  sessionId: string,
  initialStatus: SessionStatus | undefined,
  factory: EventSourceFactory = defaultFactory,
): SessionStream {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const seqRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  seqRef.current = Math.max(seqRef.current, maxSeq(state));

  useEffect(() => {
    let cancelled = false;
    let es: EventSourceLike | null = null;
    const ctrl = new AbortController();
    dispatch({ type: 'reset' });
    seqRef.current = 0;
    setLoading(true);
    setError(null);

    const catchUp = async () => {
      for (;;) {
        const res = await api.listEvents(sessionId, seqRef.current, ctrl.signal);
        if (cancelled) return;
        if (res.events.length) {
          seqRef.current = Math.max(seqRef.current, ...res.events.map((e) => e.seq));
          dispatch({ type: 'events', events: res.events });
        }
        if (!res.hasMore || res.events.length === 0) return;
      }
    };

    const onEvt = (raw: MessageEvent<string>) => {
      const ev = parse<PublicEvent>(raw.data);
      if (!ev) return;
      if (seqRef.current > 0 && ev.seq > seqRef.current + 1) {
        // Gap: fill from REST, then apply this event too (the reducer de-duplicates).
        void catchUp()
          .then(() => dispatch({ type: 'events', events: [ev], live: true }))
          .catch(() => undefined);
        return;
      }
      seqRef.current = Math.max(seqRef.current, ev.seq);
      dispatch({ type: 'events', events: [ev], live: true });
    };

    void (async () => {
      try {
        await catchUp();
        if (cancelled) return;
        if (initialStatus) dispatch({ type: 'status', status: initialStatus });
        setLoading(false);
        es = factory(`${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/stream?afterSeq=${seqRef.current}`);
        es.addEventListener(SSE_EVENT_NAMES.evt, onEvt);
        es.addEventListener(SSE_EVENT_NAMES.eph, (raw) => {
          const eph = parse<PublicEphemeral>(raw.data);
          if (eph) dispatch({ type: 'eph', eph });
        });
        es.addEventListener(SSE_EVENT_NAMES.status, (raw) => {
          const f = parse<StatusFrame>(raw.data);
          if (f) dispatch({ type: 'status', status: f.status });
        });
        es.addEventListener('error', () => {
          // CLOSED means the server ended the stream (e.g. logout): probe /me, a 401 routes to the login page
          // via the global handler. Otherwise the browser reconnects on its own.
          if (es && es.readyState === 2) void api.me().catch(() => undefined);
        });
      } catch (e) {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
      es?.close();
    };
    // initialStatus is only the starting value; deliberately not a dependency
  }, [sessionId, factory]);

  const send = useCallback(
    async (text: string) => {
      const ev = await api.postMessage(sessionId, text, crypto.randomUUID());
      dispatch({ type: 'events', events: [ev] });
      const st = stateRef.current.status;
      if (st === null || st === 'idle' || st === 'error') dispatch({ type: 'status', status: 'queued' });
    },
    [sessionId],
  );

  return { state, loading, error, send };
}
