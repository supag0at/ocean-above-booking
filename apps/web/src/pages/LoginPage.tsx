import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.ts';
import { initI18n, pickLocale } from '../i18n/index.ts';
import { errorTextOf } from '../components/errors.ts';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const login = useMutation({
    mutationFn: (name: string) => api.login(name),
    onSuccess: (user) => {
      qc.setQueryData(['me'], user);
      void initI18n(pickLocale(user.locale, navigator.language));
      navigate('/chat', { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (name) login.mutate(name);
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-header">
          <h1>{t('login.title')}</h1>
          <p className="hint">{t('login.subtitle')}</p>
        </div>
        <label className="field">
          <span>{t('login.username')}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} autoFocus />
        </label>
        {login.isError && (
          <p className="error" role="alert">
            {errorTextOf(t, login.error)}
          </p>
        )}
        <button type="submit" className="primary login-submit" disabled={login.isPending || !username.trim()}>
          {t('login.submit')}
        </button>
      </form>
    </div>
  );
}
