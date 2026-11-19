// Public views (A-01 §4.5, §9.4.1; CONTRACT M-1, M-2, M-4, M-17, M-21; CT-09). WHITELIST ONLY: every output
// field is picked explicitly, nothing is spread from an internal object, so fields added to internal payloads later
// can never leak. messageJson, thinking, system messages, toolResult data, profile, offending, guard, usage,
// fence and compaction summaries never appear. One function (`toPublicEvent`) serves REST and SSE.
import type { PublicEphemeral, PublicEvent, Quote, SessionStatus, SessionView, TicketView } from '@fb/contracts/web';
import type { TicketSummary } from '@fb/contracts/web';
import { iso, num } from './db.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A stored event row as the gateway reads it. */
export interface EventRow {
  seq: number;
  id: string;
  sessionId: string;
  type: string;
  actor: 'user' | 'agent' | 'system';
  ts: string;
  traceId: string;
  idempotencyKey: string;
  payload: unknown;
}

export function eventRowFromDb(r: Rec): EventRow {
  return {
    seq: num(r.seq),
    id: String(r.id),
    sessionId: String(r.session_id),
    type: String(r.type),
    actor: r.actor as EventRow['actor'],
    ts: iso(r.ts),
    traceId: String(r.trace_id),
    idempotencyKey: String(r.idempotency_key),
    payload: r.payload,
  };
}

export const EVENT_COLUMNS = 'seq, id, session_id, type, actor, ts, trace_id, idempotency_key, payload';

function hidden(e: EventRow): PublicEvent {
  return { seq: e.seq, type: 'hidden', actor: e.actor, ts: e.ts, payload: {} };
}

export function toPublicEvent(e: EventRow): PublicEvent {
  const p: Rec = isRec(e.payload) ? e.payload : {};
  const base = { seq: e.seq, actor: e.actor, ts: e.ts };
  switch (e.type) {
    case 'user.message':
      return { ...base, type: 'user.message', payload: { text: s(p.text), clientMessageId: s(p.clientMessageId) } };
    case 'agent.message': {
      if (p.role === 'assistant') {
        if (p.hasToolCalls === true) {
          // M-1 / D-64: ReAct step -> process area; text only in processText, never in `text`
          return {
            ...base,
            type: 'agent.message',
            payload: { runId: s(p.runId), messageKey: s(p.messageKey), kind: 'process', processText: s(p.processText) },
          };
        }
        const template = isRec(p.meta) && typeof p.meta.template === 'string' ? p.meta.template : undefined;
        return {
          ...base,
          type: 'agent.message',
          payload: {
            runId: s(p.runId),
            messageKey: s(p.messageKey),
            kind: 'reply',
            text: s(p.viewText),
            ...(template !== undefined ? { template } : {}),
          },
        };
      }
      if (p.role === 'toolResult') {
        // M-21: no `kind`; the frontend keys on toolCallId. No data, no messageJson.
        return {
          ...base,
          type: 'agent.message',
          payload: {
            runId: s(p.runId),
            messageKey: s(p.messageKey),
            toolCallId: s(p.toolCallId),
            toolName: s(p.toolName),
            isError: p.isError === true,
          },
        };
      }
      return hidden(e); // system (prompt, toolsAdded) and anything unexpected
    }
    case 'agent.run_started':
      return { ...base, type: 'agent.run_started', payload: { runId: s(p.runId) } };
    case 'agent.run_resumed':
      return { ...base, type: 'agent.run_resumed', payload: { runId: s(p.runId), attempt: n(p.attempt) } };
    case 'agent.run_completed':
      return { ...base, type: 'agent.run_completed', payload: { runId: s(p.runId) } };
    case 'agent.run_failed':
      return {
        ...base,
        type: 'agent.run_failed',
        payload: { runId: s(p.runId), code: (s(p.code) || 'INTERNAL') as never },
      };
    case 'agent.guard_violation':
      return {
        ...base,
        type: 'agent.guard_violation',
        payload: {
          runId: s(p.runId),
          messageKey: s(p.messageKey),
          action: p.action === 'replaced' ? 'replaced' : 'regenerate',
        },
      };
    case 'quote.offered':
      return { ...base, type: 'quote.offered', payload: { quoteId: s(p.quoteId) } };
    case 'booking.confirmed':
      return {
        ...base,
        type: 'booking.confirmed',
        payload: { quoteId: s(p.quoteId), ticketId: s(p.ticketId), ticketNo: s(p.ticketNo) },
      };
    case 'booking.failed':
      return {
        ...base,
        type: 'booking.failed',
        payload: { quoteId: s(p.quoteId), code: (s(p.code) || 'INTERNAL') as never },
      };
    default:
      return hidden(e); // agent.context_compacted (D-52) and any unregistered type: safe default
  }
}

/** Internal ephemeral envelope (already schema-checked) -> PublicEphemeral `{ type, payload }` (M-17: no fence). */
export function toPublicEphemeral(type: string, payload: Rec): PublicEphemeral | null {
  switch (type) {
    case 'agent.delta':
      return payload.reset === true
        ? { type, payload: { runId: s(payload.runId), messageKey: s(payload.messageKey), reset: true } }
        : {
            type,
            payload: { runId: s(payload.runId), messageKey: s(payload.messageKey), textDelta: s(payload.textDelta) },
          };
    case 'agent.reasoning_delta':
      return {
        type,
        payload: { runId: s(payload.runId), messageKey: s(payload.messageKey), textDelta: s(payload.textDelta) },
      };
    case 'agent.tool_status':
      return {
        type,
        payload: {
          runId: s(payload.runId),
          toolCallId: s(payload.toolCallId),
          name: s(payload.name),
          phase: payload.phase === 'end' ? 'end' : 'start',
          ...(typeof payload.isError === 'boolean' ? { isError: payload.isError } : {}),
        },
      };
    default:
      return null;
  }
}

// ---------- REST views ----------

/** Display status (A-01 §6.4). Only for display: no logic may branch on it. */
export function displayStatus(t: {
  openRunId: string | null;
  lastUserSeq: number;
  consumedUpToSeq: number;
  lastRunOutcome: string | null;
}): SessionStatus {
  if (t.openRunId !== null) return 'running';
  if (t.lastUserSeq > t.consumedUpToSeq) return 'queued';
  if (t.lastRunOutcome === 'failed') return 'error';
  return 'idle';
}

export const SESSION_COLUMNS = 'id, title, locale, status, last_seq, created_at, updated_at';

export function sessionView(r: Rec): SessionView {
  return {
    id: String(r.id),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    locale: r.locale === 'en' ? 'en' : 'zh',
    status: r.status as SessionStatus,
    lastSeq: num(r.last_seq),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Quote payload (written by hands, A-02 §7.2) -> contract Quote, field by field. */
export function quoteView(payload: unknown): Quote {
  const p: Rec = isRec(payload) ? payload : {};
  const d: Rec = isRec(p.display) ? p.display : {};
  return {
    quoteId: s(p.quoteId),
    from: s(p.from),
    to: s(p.to),
    legs: (Array.isArray(p.legs) ? p.legs : []).map((l: unknown) => {
      const x: Rec = isRec(l) ? l : {};
      return { from: s(x.from), to: s(x.to), distanceKm: n(x.distanceKm) };
    }),
    transferCities: (Array.isArray(p.transferCities) ? p.transferCities : []).map(s),
    totalDistanceKm: n(p.totalDistanceKm),
    priceCents: n(p.priceCents),
    display: {
      legs: (Array.isArray(d.legs) ? d.legs : []).map(s),
      totalDistanceKm: s(d.totalDistanceKm),
      priceUsd: s(d.priceUsd),
    },
    dataSha256: s(p.dataSha256),
    createdAt: s(p.createdAt),
  };
}

export const TICKET_COLUMNS =
  'id, ticket_no, session_id, quote_id, from_city, to_city, itinerary, price_cents, booked_at';

export function ticketView(r: Rec): TicketView {
  return {
    ticketId: String(r.id),
    ticketNo: String(r.ticket_no),
    sessionId: String(r.session_id),
    quoteId: String(r.quote_id),
    from: String(r.from_city),
    to: String(r.to_city),
    itinerary: quoteView(r.itinerary),
    priceCents: num(r.price_cents),
    bookedAt: iso(r.booked_at),
  };
}

/** A ticket as booking returned it (already schema-checked) re-picked field by field. */
export function pickTicket(t: TicketView): TicketView {
  return {
    ticketId: t.ticketId,
    ticketNo: t.ticketNo,
    sessionId: t.sessionId,
    quoteId: t.quoteId,
    from: t.from,
    to: t.to,
    itinerary: quoteView(t.itinerary),
    priceCents: t.priceCents,
    bookedAt: t.bookedAt,
  };
}

/** TicketSummary (A-01 §4.5, C-8): copied from the quote snapshot; no freshly computed numbers. */
export function ticketSummary(t: TicketView): TicketSummary {
  return {
    ticketNo: t.ticketNo,
    from: t.from,
    to: t.to,
    legs: t.itinerary.legs.map((l) => ({ from: l.from, to: l.to })),
    transferCities: [...t.itinerary.transferCities],
    display: {
      legs: [...t.itinerary.display.legs],
      totalDistanceKm: t.itinerary.display.totalDistanceKm,
      priceUsd: t.itinerary.display.priceUsd,
    },
  };
}
