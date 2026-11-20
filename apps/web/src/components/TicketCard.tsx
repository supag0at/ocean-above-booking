// System ticket card (A-01 §9.3.1, D-39): after booking the agent says nothing, so this card alone reports the
// result. Marked as a SYSTEM message. Data: GET /tickets/:ticketId (or the confirm response via the query cache).
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api/client.ts';
import { Itinerary } from './Itinerary.tsx';

export function TicketCard({ ticketId, ticketNo }: { ticketId: string; ticketNo: string }) {
  const { t, i18n } = useTranslation();
  const query = useQuery({ queryKey: ['ticket', ticketId], queryFn: () => api.getTicket(ticketId) });
  const ticket = query.data;
  return (
    <article className="card ticket-card system" data-testid="ticket-card">
      <span className="badge">{t('ticket.system')}</span>
      <h3>✓ {t('ticket.issued')}</h3>
      <p>
        {t('ticket.ticketNo')}: <strong data-testid="ticket-no">{ticketNo}</strong>
      </p>
      {ticket ? (
        <>
          <Itinerary quote={ticket.itinerary} />
          <p className="booked-at">
            {t('ticket.bookedAt')}:{' '}
            {new Date(ticket.bookedAt).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}
          </p>
        </>
      ) : query.isPending ? (
        <p className="hint">{t('common.loading')}</p>
      ) : null}
      <Link to={`/tickets/${encodeURIComponent(ticketId)}`}>{t('ticket.view')}</Link>
    </article>
  );
}

/** booking.failed is shown on the quote card (QuoteCard), nothing separate is rendered here. */
