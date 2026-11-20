// quote_route (A-02 §7.2). Numbers come only from FlightCore.quoteRoute; hands adds id, data hash and timestamp,
// inserts the immutable quote and returns a number-free llmText (H-01).
import { newQuoteId } from '@fb/contracts/server';
import type { QuoteRouteParamsT } from '@fb/contracts/tools';
import type { Quote } from '@fb/contracts/web';
import { insertQuote } from '../db.ts';
import { fail, ok, type ToolHandler } from './types.ts';

export function quoteText(q: Quote): string {
  const path = [q.from, ...q.transferCities, q.to].join(' → ');
  const legs = `${q.legs.length} leg${q.legs.length === 1 ? '' : 's'}`;
  const n = q.transferCities.length;
  const transfers = n === 0 ? 'direct' : `${n} transfer${n === 1 ? '' : 's'} at ${q.transferCities.join(', ')}`;
  return (
    `Quote ${q.quoteId} created: ${path} (${legs}, ${transfers}). ` +
    'Distance and price are shown to the user on the quote card. ' +
    'Call offer_booking with this quoteId now. Asking for the route is enough to show the card; the card does not book the ticket.'
  );
}

export const quoteRoute: ToolHandler = async (ctx, raw) => {
  const input = raw as QuoteRouteParamsT;
  const fc = ctx.deps.flightCore;
  const from = input.from.normalize('NFC');
  const to = input.to.normalize('NFC');
  for (const name of [from, to]) {
    if (fc.getCity(name) === undefined) {
      return fail(
        'CITY_NOT_FOUND',
        `'${name}' is not an exact city name. Call resolve_city first and use the city it returns.`,
        { city: name },
      );
    }
  }

  const r = fc.quoteRoute(from, to);
  if (!r.ok) {
    switch (r.code) {
      case 'SAME_CITY':
        return fail('SAME_CITY', 'Origin and destination are the same city. Ask the user for a different one.');
      case 'NO_ROUTE':
        return fail('NO_ROUTE', `No route connects ${from} and ${to} in the Ocean Above network.`);
      case 'CITY_NOT_SERVED': {
        const city = fc.isServed(from) ? to : from;
        const near = r.nearestServed ?? fc.nearestServed(city);
        const hint = near ? ` Nearest served city: ${near.city} (${near.distanceKm} km away).` : '';
        return fail('CITY_NOT_SERVED', `${city} has no Ocean Above flights.${hint}`, {
          city,
          nearestServed: near ? { ...near } : null,
        });
      }
      case 'CITY_NOT_FOUND':
        return fail('CITY_NOT_FOUND', 'Not an exact city name. Call resolve_city first.');
    }
  }

  const route = r.route;
  const quote: Quote = {
    quoteId: newQuoteId(),
    from: route.from,
    to: route.to,
    legs: route.legs.map((l) => ({ from: l.from, to: l.to, distanceKm: l.distanceKm })),
    transferCities: [...route.transferCities],
    totalDistanceKm: route.totalDistanceKm,
    priceCents: route.priceCents,
    display: {
      legs: [...route.display.legs],
      totalDistanceKm: route.display.totalDistanceKm,
      priceUsd: route.display.priceUsd,
    },
    dataSha256: fc.dataSha256,
    createdAt: ctx.now.toISOString(),
  };
  await insertQuote(ctx.db, ctx.userId, ctx.sessionId, quote);
  return ok(quoteText(quote), { ...quote });
};
