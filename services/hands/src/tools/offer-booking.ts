// offer_booking (A-02 §7.3): records that the card was shown. It never books (H-02).
import type { OfferBookingParamsT } from '@fb/contracts/tools';
import { insertQuoteOffer, quoteInSession, ticketNoForQuote } from '../db.ts';
import { fail, ok, type ToolHandler } from './types.ts';

export const offerBooking: ToolHandler = async (ctx, raw) => {
  const { quoteId } = raw as OfferBookingParamsT;
  if (!(await quoteInSession(ctx.db, quoteId, ctx.sessionId, ctx.userId))) {
    return fail(
      'QUOTE_NOT_FOUND',
      `Quote ${quoteId} does not exist in this conversation. Create one with quote_route.`,
    );
  }
  const ticketNo = await ticketNoForQuote(ctx.db, quoteId);
  if (ticketNo !== undefined) {
    return fail('QUOTE_ALREADY_BOOKED', `Quote ${quoteId} has already been booked (ticket ${ticketNo}).`, {
      quoteId,
      ticketNo,
    });
  }
  await insertQuoteOffer(ctx.db, quoteId, ctx.sessionId, ctx.toolCallId);
  return ok(
    `Booking card shown for ${quoteId}. The user must click the confirm button on the card to book. You cannot book on their behalf.`,
    { quoteId, offered: true },
  );
};
