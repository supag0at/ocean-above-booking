// list_my_tickets (A-02 §7.4): read-only, identity from the token. Numbers in llmText are copied from the
// stored itinerary.display, never recomputed (the number guard allows quoting them, A-02 §8.4).
import type { ListMyTicketsParamsT } from '@fb/contracts/tools';
import type { TicketView } from '@fb/contracts/web';
import { listTickets } from '../db.ts';
import { fail, ok, type ToolHandler } from './types.ts';

export const DEFAULT_TICKET_LIMIT = 20;

function ticketLine(t: TicketView): string {
  const it = t.itinerary;
  const path = [it.from, ...it.transferCities, it.to].join('→');
  return `[${t.ticketNo} ${t.bookedAt.slice(0, 10)}] ${path}, ${it.display.totalDistanceKm} km, USD ${it.display.priceUsd}`;
}

export function ticketsText(tickets: readonly TicketView[], total: number, city?: string): string {
  const scope = city === undefined ? '' : ` involving ${city}`;
  if (total === 0) return `No tickets${scope}.`;
  const head =
    tickets.length < total
      ? `${total} tickets${scope}, showing the newest ${tickets.length}: `
      : `${total} ticket${total === 1 ? '' : 's'}${scope} (newest first): `;
  return head + tickets.map(ticketLine).join('; ');
}

export const listMyTickets: ToolHandler = async (ctx, raw) => {
  const input = raw as ListMyTicketsParamsT;
  let city: string | undefined;
  if (input.city !== undefined) {
    city = input.city.normalize('NFC');
    if (ctx.deps.flightCore.getCity(city) === undefined) {
      return fail('CITY_NOT_FOUND', `'${city}' is not an exact city name. Call resolve_city first.`, { city });
    }
  }
  const limit = input.limit ?? DEFAULT_TICKET_LIMIT;
  const { tickets, total } = await listTickets(ctx.db, ctx.userId, city === undefined ? { limit } : { city, limit });
  return ok(ticketsText(tickets, total, city), { tickets, total });
};
