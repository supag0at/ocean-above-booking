import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Locale, SessionView } from '@fb/contracts/web';
import { api } from '../api/client.ts';
import { buildTimeline } from '../chat/state.ts';
import { useSessionStream } from '../chat/useSessionStream.ts';
import { ProcessArea } from '../components/ProcessArea.tsx';
import { QuoteCard } from '../components/QuoteCard.tsx';
import { SafeMarkdown } from '../components/SafeMarkdown.tsx';
import { TicketCard } from '../components/TicketCard.tsx';
import { errorTextOf } from '../components/errors.ts';
import { i18next } from '../i18n/index.ts';

/** /chat: render the empty chat screen lazily and only create a session when the first message is sent. */
export function NewChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const draftSessionRef = useRef<SessionView | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const locale = (i18next.language === 'en' ? 'en' : 'zh') as Locale;
      const session = draftSessionRef.current ?? (await api.createSession(locale));
      draftSessionRef.current = session;
      await api.postMessage(session.id, value, crypto.randomUUID());
      draftSessionRef.current = null;
      qc.setQueryData(['session', session.id], { ...session, status: 'queued' as const });
      void qc.invalidateQueries({ queryKey: ['sidebar-sessions'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      setText('');
      navigate(`/chat/${encodeURIComponent(session.id)}`, { replace: true });
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat chat-empty">
      <div className="messages" data-testid="messages">
        <div className="messages-inner">
          <div className="empty-hero">
            <h2>{t('app.name')}</h2>
            <p className="hint">{t('chat.empty')}</p>
          </div>
        </div>
      </div>
      <div className="composer-bar">
        <form className="composer" onSubmit={(e) => void submit(e)}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('chat.placeholder')}
            maxLength={2000}
            rows={2}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(e);
              }
            }}
          />
          <button type="submit" className="primary composer-send" disabled={sending || !text.trim()}>
            {sending ? t('chat.sending') : t('chat.send')}
          </button>
        </form>
        {sendError ? (
          <p className="error composer-error" role="alert">
            {errorTextOf(t, sendError)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPage() {
  const { sessionId } = useParams();
  const { t } = useTranslation();
  const session = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId!),
    enabled: !!sessionId,
    staleTime: Infinity,
  });
  if (!sessionId) return <Navigate to="/chat" replace />;
  if (session.isPending) return <p className="center">{t('common.loading')}</p>;
  if (session.isError) {
    return (
      <p className="error" role="alert">
        {errorTextOf(t, session.error)}
      </p>
    );
  }
  return <ChatView key={sessionId} sessionId={sessionId} initialStatus={session.data.status} />;
}

function ChatView({
  sessionId,
  initialStatus,
}: {
  sessionId: string;
  initialStatus: 'idle' | 'queued' | 'running' | 'error';
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { state, loading, error, send } = useSessionStream(sessionId, initialStatus);
  const timeline = useMemo(() => buildTimeline(state), [state]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [timeline.items.length, timeline.typing, state.live]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await send(value);
      setText('');
      void qc.invalidateQueries({ queryKey: ['sidebar-sessions'] });
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  };

  const isEmpty = !loading && !error && timeline.items.length === 0 && !timeline.typing;

  return (
    <div className={isEmpty ? 'chat chat-empty' : 'chat'}>
      <div className="messages" data-testid="messages">
        <div className="messages-inner">
          {loading && <p className="center">{t('common.loading')}</p>}
          {error ? (
            <p className="error" role="alert">
              {t('chat.loadFailed')}
            </p>
          ) : null}
          {isEmpty && (
            <div className="empty-hero">
              <h2>{t('app.name')}</h2>
              <p className="hint">{t('chat.empty')}</p>
            </div>
          )}
          {timeline.items.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div key={item.key} className="bubble user" data-testid="user-bubble">
                    {item.text}
                  </div>
                );
              case 'reply':
                return (
                  <div key={item.key} className="bubble agent" data-testid="agent-bubble">
                    <SafeMarkdown text={item.text} />
                  </div>
                );
              case 'run':
                return <ProcessArea key={item.key} run={item} />;
              case 'quote':
                return (
                  <QuoteCard key={item.key} quoteId={item.quoteId} booked={item.booked} failedCode={item.failedCode} />
                );
              case 'ticket':
                return <TicketCard key={item.key} ticketId={item.ticketId} ticketNo={item.ticketNo} />;
            }
          })}
          {timeline.typing && (
            <div className="typing" role="status" aria-label={t('chat.typing')} data-testid="typing">
              <span />
              <span />
              <span />
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer-bar">
        <form className="composer" onSubmit={(e) => void submit(e)}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('chat.placeholder')}
            maxLength={2000}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(e);
              }
            }}
          />
          <button type="submit" className="primary composer-send" disabled={sending || !text.trim()}>
            {sending ? t('chat.sending') : t('chat.send')}
          </button>
        </form>
        {sendError ? (
          <p className="error composer-error" role="alert">
            {errorTextOf(t, sendError)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
