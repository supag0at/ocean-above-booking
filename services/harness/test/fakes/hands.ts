// hands stand-in (A-02 §5, A-01 §5.5): fixed tool results, idempotent per (runId, toolCallId) with an input hash,
// optional gates to hold a tool call open (crash tests). Implements the Hands port directly.
import { canonicalJson, newQuoteId } from '@fb/contracts/server';
import type { ExecuteRequest, ExecuteResponse } from '@fb/contracts/tools';
import type { Hands, HandsResult } from '../../src/ports.ts';

/** Fictional coordinates: values are taken from eval/cases (guards.yaml allowSetsUsed), never computed here. */
export const ROUTES: Record<string, { via: string[]; legs: string[]; total: string; price: string; km: number[] }> = {
  'Shanghai|São Paulo': {
    via: ['Hong Kong'],
    legs: ['1717.86', '1542.07'],
    total: '3259.93',
    price: '423.79',
    km: [1717.8631, 1542.0712],
  },
  'Shanghai|Tokyo': {
    via: ['Atlanta'],
    legs: ['5040.02', '2115.08'],
    total: '7155.09',
    price: '930.16',
    km: [5040.0213, 2115.0745],
  },
};

const CITIES: Record<string, { city: string; served: boolean; isHub: boolean }> = {
  shanghai: { city: 'Shanghai', served: true, isHub: true },
  'sao paulo': { city: 'São Paulo', served: true, isHub: true },
  tokyo: { city: 'Tokyo', served: true, isHub: true },
  austin: { city: 'Austin', served: false, isHub: false },
};
const norm = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, ' ')
    .trim();

export class FakeHands implements Hands {
  readonly calls: { req: ExecuteRequest; replay: boolean }[] = [];
  private readonly store = new Map<string, { hash: string; res: ExecuteResponse }>();
  /** a tool name -> promise the call waits on before answering (crash tests) */
  readonly gates = new Map<string, Promise<void>>();
  /** called when a gated call starts waiting */
  onGateHit?: (req: ExecuteRequest) => void;
  /** test hook: force a transport result for a call */
  failWith?: (req: ExecuteRequest) => 'auth' | 'unavailable' | undefined;
  frozen = false;
  profile: Record<string, unknown> = { frequentRoutes: [], ticketCount: 0 };

  async execute(token: string, req: ExecuteRequest): Promise<HandsResult> {
    if (this.frozen) return new Promise<HandsResult>(() => undefined);
    if (!token.startsWith('hands-token:')) return { status: 'auth' };
    const forced = this.failWith?.(req);
    if (forced !== undefined) return { status: forced };
    const key = `${req.runId}|${req.toolCallId}`;
    const hash = canonicalJson(req.input);
    const prev = this.store.get(key);
    this.calls.push({ req, replay: prev !== undefined });
    if (prev !== undefined) {
      if (prev.hash !== hash) {
        return {
          status: 'ok',
          response: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', llmText: 'different input for this call id' } },
        };
      }
      return { status: 'ok', response: prev.res };
    }
    const gate = this.gates.get(req.name);
    if (gate !== undefined) {
      this.onGateHit?.(req);
      await gate;
      if (this.frozen) return new Promise<HandsResult>(() => undefined);
    }
    const res = this.run(req);
    this.store.set(key, { hash, res });
    return { status: 'ok', response: res };
  }

  private run(req: ExecuteRequest): ExecuteResponse {
    const i = req.input as Record<string, unknown>;
    switch (req.name) {
      case 'sys.profile_snapshot':
        return { ok: true, llmText: '', data: this.profile };
      case 'resolve_city': {
        const cands = [...((i.candidates as string[]) ?? []), String(i.original ?? '')];
        for (const c of cands) {
          const hit = CITIES[norm(c)];
          if (hit) {
            const nearest = hit.served ? null : { city: 'Copenhagen', distanceKm: '120.95' };
            const match = { ...hit, connectedHubs: [], nearestServed: nearest };
            const text = hit.served
              ? `exact: ${hit.city} (${hit.isHub ? 'hub, ' : ''}served)`
              : `exact: ${hit.city} (NOT served). Nearest served city: Copenhagen (120.95 km away).`;
            return {
              ok: true,
              llmText: text,
              data: { status: 'exact', matches: [match], matchedBy: { source: 'candidate', index: 0 } },
            };
          }
        }
        return {
          ok: true,
          llmText: 'not_found: no city with a similar name in the Ocean Above network.',
          data: { status: 'not_found', matches: [] },
        };
      }
      case 'quote_route': {
        const r = ROUTES[`${String(i.from)}|${String(i.to)}`];
        if (r === undefined) {
          return {
            ok: false,
            error: {
              code: 'CITY_NOT_FOUND',
              llmText: `'${String(i.from)}' or '${String(i.to)}' is not an exact city name. Call resolve_city first.`,
            },
          };
        }
        const cities = [String(i.from), ...r.via, String(i.to)];
        const quoteId = newQuoteId();
        const legs = cities.slice(1).map((to, k) => ({ from: cities[k] as string, to, distanceKm: r.km[k] as number }));
        return {
          ok: true,
          llmText: `Quote ${quoteId} created: ${cities.join(' → ')} (${legs.length} legs, ${r.via.length} transfer at ${r.via.join(', ')}). Distance and price are shown to the user on the quote card. Call offer_booking with this quoteId now. Asking for the route is enough to show the card; the card does not book the ticket.`,
          data: {
            quoteId,
            from: i.from,
            to: i.to,
            legs,
            transferCities: r.via,
            totalDistanceKm: r.km.reduce((a, b) => a + b, 0),
            priceCents: Math.round(Number(r.price) * 100),
            display: { legs: r.legs, totalDistanceKm: r.total, priceUsd: r.price },
            dataSha256: 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f',
            createdAt: '2026-11-19T08:00:00.000Z',
          },
        };
      }
      case 'offer_booking':
        return {
          ok: true,
          llmText: `Booking card shown for ${String(i.quoteId)}. The user must click the confirm button on the card to book. You cannot book on their behalf.`,
          data: { quoteId: i.quoteId, offered: true },
        };
      case 'list_my_tickets':
        return { ok: true, llmText: '0 tickets.', data: { tickets: [], total: 0 } };
      case 'save_preference':
        return {
          ok: true,
          llmText: `Saved: ${String(i.key)} = ${String(i.value)}.`,
          data: { key: i.key, value: i.value },
        };
      case 'forget_preference':
        return { ok: true, llmText: `Forgot: ${String(i.key)}.`, data: { key: i.key } };
      default:
        return { ok: false, error: { code: 'UNKNOWN_TOOL', llmText: `unknown tool ${req.name}` } };
    }
  }
}
