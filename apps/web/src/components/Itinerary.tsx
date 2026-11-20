// Shared itinerary rendering for QuoteCard / TicketCard. Every number is a string from `quote.display`
// (server-formatted, A-01 §4.5): this component does no arithmetic and no formatting of its own (M-13).
import { useTranslation } from 'react-i18next';
import type { Quote } from '@fb/contracts/web';

export function Itinerary({ quote }: { quote: Quote }) {
  const { t } = useTranslation();
  const direct = quote.transferCities.length === 0;
  return (
    <div className="itinerary">
      <p className="route-line" data-testid="route-line">
        {[quote.from, ...quote.transferCities, quote.to].join(' → ')}
      </p>
      <p className="transfer-note" data-testid="transfer-note">
        {direct ? t('quote.direct') : quote.transferCities.map((c) => t('quote.transferAt', { city: c })).join('；')}
      </p>
      <ol className="legs">
        {quote.legs.map((leg, i) => (
          <li key={`${leg.from}>${leg.to}>${i}`} data-testid="leg">
            <span className="leg-route">
              {leg.from} → {leg.to}
            </span>
            <span className="leg-km">
              {quote.display.legs[i]} {t('quote.km')}
            </span>
          </li>
        ))}
      </ol>
      <dl className="totals">
        <dt>{t('quote.totalDistance')}</dt>
        <dd data-testid="total-distance">
          {quote.display.totalDistanceKm} {t('quote.km')}
        </dd>
        <dt>{t('quote.price')}</dt>
        <dd data-testid="price" className="price">
          {quote.display.priceUsd} {t('quote.usd')}
        </dd>
      </dl>
    </div>
  );
}
