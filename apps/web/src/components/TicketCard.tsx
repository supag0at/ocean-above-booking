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
      <div className="card-header">
        <div className="ticket-card-title">
          <h3 className="booked">✓ {t('ticket.issued')}</h3>
          <span className="badge">{t('ticket.system')}</span>
        </div>
        <span className="ticket-no-chip">
          {t('ticket.ticketNo')}: <strong data-testid="ticket-no">{ticketNo}</strong>
        </span>
      </div>
      {ticket ? (
        <Itinerary quote={ticket.itinerary} />
      ) : query.isPending ? (
        <p className="hint">{t('common.loading')}</p>
      ) : null}
      <div className="ticket-footer">
        {ticket ? (
          <span className="booked-at">
            {t('ticket.bookedAt')}:{' '}
            {new Date(ticket.bookedAt).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}
          </span>
        ) : (
          <span />
        )}
        <Link to={`/tickets/${encodeURIComponent(ticketId)}`} className="ticket-link">
          {t('ticket.view')} →
        </Link>
      </div>
    </article>
  );
}

/** booking.failed is shown on the quote card (QuoteCard), nothing separate is rendered here. */
