import { useEffect, useState } from 'react';
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

function NavIcon({ kind }: { kind: 'plus' | 'history' | 'tickets' | 'profile' }) {
  const props = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'nav-icon',
  };
  switch (kind) {
    case 'plus':
      return (
        <svg {...props}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'history':
      return (
        <svg {...props}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case 'tickets':
      return (
        <svg {...props}>
          <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V9z" />
          <path d="M13 7v10" strokeDasharray="2 2" />
        </svg>
      );
    case 'profile':
      return (
        <svg {...props}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20a8 8 0 0 1 16 0" />
        </svg>
      );
  }
}

/** Authenticated shell: left sidebar (nav, recent chats, account) on desktop; collapses to topbar on narrow screens. */
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

  const recentSessions = useQuery({
    queryKey: ['sidebar-sessions'],
    queryFn: () => api.listSessions(),
    enabled: !!user,
    staleTime: 15_000,
  });

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
  const sidebarItems = recentSessions.data?.items.slice(0, 12) ?? [];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <strong className="brand">{t('app.name')}</strong>
        </div>

        <nav className="sidebar-nav" aria-label={t('app.name')}>
          <NavLink to="/chat" end className="nav-new-chat">
            <NavIcon kind="plus" />
            <span>{t('nav.chat')}</span>
          </NavLink>
          <NavLink to="/history" className="nav-item">
            <NavIcon kind="history" />
            <span>{t('nav.history')}</span>
          </NavLink>
          <NavLink to="/tickets" className="nav-item">
            <NavIcon kind="tickets" />
            <span>{t('nav.tickets')}</span>
          </NavLink>
          <NavLink to="/profile" className="nav-item">
            <NavIcon kind="profile" />
            <span>{t('nav.profile')}</span>
          </NavLink>
        </nav>

        {sidebarItems.length > 0 && (
          <div className="sidebar-recent">
            <div className="sidebar-section-label">{t('nav.history')}</div>
            <ul className="sidebar-sessions">
              {sidebarItems.map((s) => (
                <li key={s.id}>
                  <NavLink to={`/chat/${encodeURIComponent(s.id)}`} className="sidebar-session-link">
                    <span className="sidebar-session-title">{s.title ?? t('history.untitled')}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span className="user-avatar" aria-hidden="true">
              {(user?.username?.[0] ?? '?').toUpperCase()}
            </span>
            <span className="username">{user?.username}</span>
          </div>
          <div className="sidebar-controls">
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
            <button type="button" className="link-button logout-btn" onClick={() => logout.mutate()}>
              {t('nav.logout')}
            </button>
          </div>
        </div>
      </aside>

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
  const [client] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
