// Quote card (A-01 §9.3). Data source: GET /quotes/:quoteId only (H-01); nothing is read from LLM text.
// The confirm button is the ONLY order entry point (D-06): one click submits, no second dialog.
// Button states: available | pending | booked | error (retry allowed).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ErrorCode, QuoteView } from '@fb/contracts/web';
import { ApiRequestError, api } from '../api/client.ts';
import { Itinerary } from './Itinerary.tsx';
import { errorText } from './errors.ts';

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX = 20;

interface Props {
  quoteId: string;
  /** From a booking.confirmed event in the stream. */
  booked: { ticketId: string; ticketNo: string } | null;
  /** From a booking.failed event in the stream. */
  failedCode: ErrorCode | null;
}

export function QuoteCard({ quoteId, booked: bookedFromEvent, failedCode }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['quote', quoteId], queryFn: () => api.getQuote(quoteId) });
  const [pending, setPending] = useState(false);
  const [polling, setPolling] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const attempts = useRef(0);

  const markBooked = useCallback(
    (ticketId: string, ticketNo: string) => {
      qc.setQueryData<QuoteView>(['quote', quoteId], (old) =>
        old ? { ...old, booking: { status: 'booked', ticketId, ticketNo } } : old,
      );
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    [qc, quoteId],
  );

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setErrorCode(null);
    try {
      const ticket = await api.confirmQuote(quoteId);
      qc.setQueryData(['ticket', ticket.ticketId], ticket);
      markBooked(ticket.ticketId, ticket.ticketNo);
    } catch (e) {
      const code = e instanceof ApiRequestError ? e.code : 'UNKNOWN';
      setErrorCode(code);
      if (code === 'BOOKING_UNAVAILABLE') {
        attempts.current = 0;
        setPolling(true); // §9.3: show "confirming", poll GET /quotes/:id every 3 s, at most 20 times
      }
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      attempts.current += 1;
      void api
        .getQuote(quoteId)
        .then((q) => {
          if (q.booking.status === 'booked') {
            qc.setQueryData(['quote', quoteId], q);
            void qc.invalidateQueries({ queryKey: ['tickets'] });
            setPolling(false);
            setErrorCode(null);
          } else if (attempts.current >= POLL_MAX) {
            setPolling(false);
          }
        })
        .catch(() => {
          if (attempts.current >= POLL_MAX) setPolling(false);
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [polling, quoteId, qc]);

  if (query.isPending) return <div className="card quote-card">{t('common.loading')}</div>;
  if (query.isError || !query.data) {
    return (
      <div className="card quote-card" role="alert">
        {t('quote.loadFailed')}{' '}
        <button type="button" className="link-button" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  const { quote, booking } = query.data;
  const booked = booking.status === 'booked' ? booking : bookedFromEvent;
  const shownError = polling ? null : (errorCode ?? failedCode);

  return (
    <article className="card quote-card" data-testid="quote-card" data-quote-id={quoteId}>
      <div className="card-header">
        <h3>{t('quote.title')}</h3>
        {booked && <span className="status-pill booked-pill">✓ {t('quote.booked')}</span>}
      </div>
      <Itinerary quote={quote} />
      <p className="pricing-note">{t('quote.pricingNote')}</p>
      {booked ? (
        <div className="quote-footer quote-footer-booked">
          <p className="booked" data-testid="booked-state">
            ✓ {t('quote.booked')} · {t('quote.ticketNo')} <strong>{booked.ticketNo}</strong>
          </p>
        </div>
      ) : (
        <div className="quote-footer">
          <div className="quote-footer-meta">
            <p className="fine-print">{t('quote.onlyThisButton')}</p>
            {polling && (
              <p className="hint" role="status">
                {errorText(t, 'BOOKING_UNAVAILABLE')}
              </p>
            )}
            {shownError && (
              <p className="error" role="alert" data-testid="quote-error">
                {errorText(t, shownError)}
              </p>
            )}
          </div>
          <button
            type="button"
            className="primary"
            data-testid="confirm-button"
            disabled={pending || polling}
            onClick={() => void confirm()}
          >
            {pending || polling ? t('quote.confirming') : t('quote.confirm')}
          </button>
        </div>
      )}
    </article>
  );
}
