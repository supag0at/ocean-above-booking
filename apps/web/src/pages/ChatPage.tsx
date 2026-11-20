import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Locale } from '@fb/contracts/web';
import { api } from '../api/client.ts';
import { buildTimeline } from '../chat/state.ts';
import { useSessionStream } from '../chat/useSessionStream.ts';
import { ProcessArea } from '../components/ProcessArea.tsx';
import { QuoteCard } from '../components/QuoteCard.tsx';
import { SafeMarkdown } from '../components/SafeMarkdown.tsx';
import { TicketCard } from '../components/TicketCard.tsx';
import { errorTextOf } from '../components/errors.ts';
import { i18next } from '../i18n/index.ts';

/** /chat: create a session with the current UI language, then go to /chat/:id (A-01 §9.2, §9.6). */
export function NewChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const started = useRef(false);
  const create = useMutation({
    mutationFn: () => api.createSession((i18next.language === 'en' ? 'en' : 'zh') as Locale),
    onSuccess: (s) => navigate(`/chat/${encodeURIComponent(s.id)}`, { replace: true }),
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    create.mutate();
    // create exactly once, even under StrictMode
  }, []);
  if (create.isError) {
    return (
      <p className="error" role="alert">
        {errorTextOf(t, create.error)}{' '}
        <button type="button" className="link-button" onClick={() => create.mutate()}>
          {t('common.retry')}
        </button>
      </p>
    );
  }
  return <p className="center">{t('common.loading')}</p>;
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
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <div className="messages" data-testid="messages">
        {loading && <p className="center">{t('common.loading')}</p>}
        {error ? (
          <p className="error" role="alert">
            {t('chat.loadFailed')}
          </p>
        ) : null}
        {!loading && timeline.items.length === 0 && <p className="center hint">{t('chat.empty')}</p>}
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
        <button type="submit" className="primary" disabled={sending || !text.trim()}>
          {sending ? t('chat.sending') : t('chat.send')}
        </button>
      </form>
      {sendError ? (
        <p className="error" role="alert">
          {errorTextOf(t, sendError)}
        </p>
      ) : null}
    </div>
  );
}
