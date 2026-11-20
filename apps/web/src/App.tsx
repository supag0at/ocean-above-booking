import { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Locale, UserView } from '@fb/contracts/web';
import { ApiRequestError, api, setUnauthorizedHandler } from './api/client.ts';
import { i18next, initI18n, pickLocale } from './i18n/index.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { NewChatPage, ChatPage } from './pages/ChatPage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { TicketDetailPage, TicketsPage } from './pages/TicketsPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity, retry: false });
}

/** Authenticated shell: top bar (nav, language switch, logout) plus the routed page. */
function Shell() {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    // Any 401 anywhere (including a closed SSE stream after logout) lands on the login page.
    setUnauthorizedHandler(() => {
      qc.clear();
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc, navigate]);

  const user = me.data;
  useEffect(() => {
    if (user) void initI18n(pickLocale(user.locale, navigator.language));
  }, [user]);

  const setLocale = useMutation({
    mutationFn: (l: Locale) => api.setLocale(l),
    onSuccess: (u: UserView) => {
      qc.setQueryData(['me'], u);
      void initI18n(u.locale);
    },
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  if (me.isPending) return <p className="center">{t('common.loading')}</p>;
  if (me.isError) return <Navigate to="/login" replace />;
  const current: Locale = i18next.language === 'en' ? 'en' : 'zh';

  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">{t('app.name')}</strong>
        <nav>
          <NavLink to="/chat">{t('nav.chat')}</NavLink>
          <NavLink to="/history">{t('nav.history')}</NavLink>
          <NavLink to="/tickets">{t('nav.tickets')}</NavLink>
          <NavLink to="/profile">{t('nav.profile')}</NavLink>
        </nav>
        <span className="spacer" />
        <span className="username">{user?.username}</span>
        <label className="lang">
          <span className="sr-only">{t('nav.language')}</span>
          <select
            aria-label={t('nav.language')}
            value={current}
            onChange={(e) => setLocale.mutate(e.target.value as Locale)}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <button type="button" className="link-button" onClick={() => logout.mutate()}>
          {t('nav.logout')}
        </button>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route path="/chat" element={<NewChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/tickets" element={<TicketsPage />} />
        <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const client = createQueryClient();
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
