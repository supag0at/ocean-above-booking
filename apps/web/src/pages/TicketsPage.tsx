// /tickets and /tickets/:ticketId (A-01 §9.2, G-08). All numbers come from itinerary.display.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TicketView } from '@fb/contracts/web';
import { api } from '../api/client.ts';
import { Itinerary } from '../components/Itinerary.tsx';
import { errorTextOf } from '../components/errors.ts';

function TicketBody({ ticket }: { ticket: TicketView }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <p>
        {t('ticket.ticketNo')}: <strong>{ticket.ticketNo}</strong>
      </p>
      <Itinerary quote={ticket.itinerary} />
      <p className="booked-at">
        {t('ticket.bookedAt')}: {new Date(ticket.bookedAt).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}
      </p>
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
    <section>
      <h1>{t('tickets.title')}</h1>
      {tickets.length === 0 && <p className="hint">{t('tickets.empty')}</p>}
      {tickets.map((tk) => (
        <article key={tk.ticketId} className="card" data-testid="ticket-item">
          <TicketBody ticket={tk} />
          <Link to={`/tickets/${encodeURIComponent(tk.ticketId)}`}>{tk.ticketNo}</Link>
        </article>
      ))}
      {q.hasNextPage && (
        <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {t('tickets.loadMore')}
        </button>
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
    <section>
      <p>
        <Link to="/tickets">← {t('nav.tickets')}</Link>
      </p>
      <article className="card" data-testid="ticket-detail">
        <TicketBody ticket={q.data} />
      </article>
    </section>
  );
}
