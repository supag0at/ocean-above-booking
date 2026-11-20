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
    <section>
      <h1>{t('profile.title')}</h1>
      <p className="hint">{t('profile.note')}</p>
      {items.length === 0 && <p className="hint">{t('profile.empty')}</p>}
      <ul className="list">
        {items.map((m) => (
          <li key={m.memoryId} data-testid="memory-item">
            <span className="list-title">
              {t(`profile.key.${m.key}`)}: {m.value}
            </span>
            <span className="list-meta">
              <Link to={`/chat/${encodeURIComponent(m.source.sessionId)}`}>{t('profile.source')}</Link>
            </span>
            <button type="button" onClick={() => del.mutate(m.memoryId)} disabled={del.isPending}>
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>
      {items.length > 0 && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('profile.deleteAllConfirm'))) delAll.mutate();
          }}
          disabled={delAll.isPending}
        >
          {t('profile.deleteAll')}
        </button>
      )}
      {err ? (
        <p className="error" role="alert">
          {errorTextOf(t, err)}
        </p>
      ) : null}
    </section>
  );
}
