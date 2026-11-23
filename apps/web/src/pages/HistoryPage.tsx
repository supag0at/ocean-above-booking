// /history: all past conversations (A-01 §9.2, G-09). Pagination can repeat or skip rows because updated_at
// changes (§4.1), so pages are merged and de-duplicated by id.
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { SessionView } from '@fb/contracts/web';
import { api } from '../api/client.ts';
import { errorTextOf } from '../components/errors.ts';

export function HistoryPage() {
  const { t, i18n } = useTranslation();
  const q = useInfiniteQuery({
    queryKey: ['sessions'],
    queryFn: ({ pageParam }) => api.listSessions(pageParam),
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

  const seen = new Set<string>();
  const items: SessionView[] = [];
  for (const page of q.data.pages) {
    for (const s of page.items) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        items.push(s);
      }
    }
  }
  const lng = i18n.language === 'en' ? 'en-US' : 'zh-CN';
  return (
    <section className="page-container">
      <header className="page-header">
        <h1>{t('history.title')}</h1>
      </header>
      {items.length === 0 ? (
        <div className="panel empty-panel">
          <p className="hint">{t('history.empty')}</p>
        </div>
      ) : (
        <div className="panel">
          <ul className="list history-list">
            {items.map((s) => (
              <li key={s.id}>
                <Link to={`/chat/${encodeURIComponent(s.id)}`} data-testid="session-link" className="history-row">
                  <span className="list-title">{s.title ?? t('history.untitled')}</span>
                  <span className="list-meta">
                    {s.status !== 'idle' && <span className="status-pill">{t(`chat.status.${s.status}`)}</span>}
                    <span>
                      {t('history.updatedAt')} {new Date(s.updatedAt).toLocaleString(lng)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {q.hasNextPage && (
        <div className="load-more-row">
          <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {t('history.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}
