// /tickets and /tickets/:ticketId (A-01 §9.2, G-08). All numbers come from itinerary.display.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TicketView } from '@fb/contracts/web';
import { api } from '../api/client.ts';
import { Itinerary } from '../components/Itinerary.tsx';
import { errorTextOf } from '../components/errors.ts';

function TicketBody({ ticket, detailLink }: { ticket: TicketView; detailLink?: boolean }) {
  const { t, i18n } = useTranslation();
  const formattedDate = new Date(ticket.bookedAt).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN');
  return (
    <>
      <div className="card-header">
        <span className="ticket-no-chip">
          {t('ticket.ticketNo')}: <strong>{ticket.ticketNo}</strong>
        </span>
        {!detailLink && (
          <span className="booked-at">
            {t('ticket.bookedAt')}: {formattedDate}
          </span>
        )}
      </div>
      <Itinerary quote={ticket.itinerary} />
      {detailLink && (
        <div className="ticket-footer">
          <span className="booked-at">
            {t('ticket.bookedAt')}: {formattedDate}
          </span>
          <Link to={`/tickets/${encodeURIComponent(ticket.ticketId)}`} className="ticket-link">
            {t('ticket.view')} →
          </Link>
        </div>
      )}
    </>
  );
}

export function TicketsPage() {
  const { t } = useTranslation();
  const q = useInfiniteQuery({
    queryKey: ['tickets'],
    queryFn: ({ pageParam }) => api.listTickets(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  if (q.isPending) return <p className="center">{t('common.loading')}</p>;
  if (q.isError)
    return (
      <p className="error" role="alert">
        {errorTextOf(t, q.error)}
      </p>
    );
  const tickets = q.data.pages.flatMap((p) => p.items);
  return (
    <section className="page-container page-wide">
      <header className="page-header">
        <h1>{t('tickets.title')}</h1>
      </header>
      {tickets.length === 0 ? (
        <div className="panel empty-panel">
          <p className="hint">{t('tickets.empty')}</p>
        </div>
      ) : (
        <div className="tickets-grid">
          {tickets.map((tk) => (
            <article key={tk.ticketId} className="card ticket-item-card" data-testid="ticket-item">
              <TicketBody ticket={tk} detailLink />
            </article>
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <div className="load-more-row">
          <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {t('tickets.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}

export function TicketDetailPage() {
  const { ticketId } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['ticket', ticketId], queryFn: () => api.getTicket(ticketId!), enabled: !!ticketId });
  if (q.isPending) return <p className="center">{t('common.loading')}</p>;
  if (q.isError)
    return (
      <p className="error" role="alert">
        {errorTextOf(t, q.error)}
      </p>
    );
  return (
    <section className="page-container">
      <p className="back-row">
        <Link to="/tickets">← {t('nav.tickets')}</Link>
      </p>
      <article className="card" data-testid="ticket-detail">
        <TicketBody ticket={q.data} />
      </article>
    </section>
  );
}
