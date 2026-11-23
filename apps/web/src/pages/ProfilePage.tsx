// /profile: remembered preferences (long-term memory). View, delete one, or clear all (A-01 §9.2, D-13).
// DELETE endpoints take no body and no Content-Type (§4.2). Deletion takes effect on the agent's next run.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.ts';
import { errorTextOf } from '../components/errors.ts';

export function ProfilePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  const refresh = () => qc.invalidateQueries({ queryKey: ['profile'] });
  const del = useMutation({ mutationFn: (id: string) => api.deleteMemory(id), onSuccess: refresh });
  const delAll = useMutation({ mutationFn: api.deleteAllMemories, onSuccess: refresh });

  if (q.isPending) return <p className="center">{t('common.loading')}</p>;
  if (q.isError)
    return (
      <p className="error" role="alert">
        {errorTextOf(t, q.error)}
      </p>
    );
  const items = q.data;
  const err = del.error ?? delAll.error;
  return (
    <section className="page-container">
      <header className="page-header">
        <div>
          <h1>{t('profile.title')}</h1>
          <p className="hint page-subtitle">{t('profile.note')}</p>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            className="danger-button"
            onClick={() => {
              if (window.confirm(t('profile.deleteAllConfirm'))) delAll.mutate();
            }}
            disabled={delAll.isPending}
          >
            {t('profile.deleteAll')}
          </button>
        )}
      </header>
      {items.length === 0 ? (
        <div className="panel empty-panel">
          <p className="hint">{t('profile.empty')}</p>
        </div>
      ) : (
        <div className="panel">
          <ul className="list profile-list">
            {items.map((m) => (
              <li key={m.memoryId} data-testid="memory-item" className="profile-row">
                <div className="profile-kv">
                  <span className="profile-key">{t(`profile.key.${m.key}`)}</span>
                  <span className="profile-value">{m.value}</span>
                </div>
                <div className="profile-actions">
                  <Link to={`/chat/${encodeURIComponent(m.source.sessionId)}`} className="profile-source-link">
                    {t('profile.source')}
                  </Link>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => del.mutate(m.memoryId)}
                    disabled={del.isPending}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {err ? (
        <p className="error" role="alert">
          {errorTextOf(t, err)}
        </p>
      ) : null}
    </section>
  );
}
