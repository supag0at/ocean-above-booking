// ReAct process area (A-01 §9.4.1, D-63/D-64). Weakened style, always labelled as intermediate steps that are
// not a basis for any quote. Contents are PLAIN TEXT only. Expanded while the run is live; collapses once the
// run finishes (reply persisted / run_completed / run_failed). Never contains quote cards or the confirm button.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TimelineItem } from '../chat/state.ts';
import { runVisible } from '../chat/state.ts';

type RunItem = Extract<TimelineItem, { kind: 'run' }>;

export function ProcessArea({ run }: { run: RunItem }) {
  const { t } = useTranslation();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    // Folding is automatic when the run ends: forget any manual choice made while it was live.
    if (run.finished) setUserOpen(null);
  }, [run.finished]);

  if (!runVisible(run)) return null;
  const expanded = userOpen ?? !run.finished;

  const toolLabel = (name: string, phase: 'running' | 'done' | 'failed') =>
    t(`process.tool.${name}.${phase}`, { defaultValue: t(`process.tool.unknown.${phase}`) });

  const persistedTools = new Set(run.steps.filter((s) => s.kind === 'tool').map((s) => s.key));
  const live = run.live;

  return (
    <section className="process" data-testid="process-area" data-expanded={expanded} aria-label={t('process.title')}>
      <header className="process-head">
        <span className="process-title">
          {run.finished ? t('process.collapsed', { n: run.processCount }) : t('process.title')}
        </span>
        <span className="process-disclaimer"> · {t('process.disclaimer')}</span>
        {run.finished && (
          <button type="button" className="link-button" aria-expanded={expanded} onClick={() => setUserOpen(!expanded)}>
            {expanded ? t('process.collapse') : t('process.expand')} {expanded ? '▾' : '▸'}
          </button>
        )}
      </header>
      {expanded && (
        <div className="process-body">
          {run.steps.map((s) =>
            s.kind === 'text' ? (
              <p key={s.key} className="process-text">
                {s.text}
              </p>
            ) : (
              <p key={s.key} className="process-tool">
                {s.isError ? '✗ ' : '✓ '}
                {toolLabel(s.toolName, s.isError ? 'failed' : 'done')}
              </p>
            ),
          )}
          {live?.reasoning.map((r) => (
            <p key={`rs:${r.messageKey}`} className="process-reasoning">
              <span className="process-label">{t('process.reasoning')}: </span>
              {r.text}
            </p>
          ))}
          {live?.deltas.map((d) => (
            <p key={`d:${d.messageKey}`} className="process-text process-streaming">
              {d.text}
            </p>
          ))}
          {live?.tools
            .filter((x) => !persistedTools.has(`t:${x.toolCallId}`))
            .map((x) => (
              <p key={`ts:${x.toolCallId}`} className="process-tool">
                {x.phase === 'start'
                  ? '… ' + toolLabel(x.name, 'running')
                  : (x.isError ? '✗ ' : '✓ ') + toolLabel(x.name, x.isError ? 'failed' : 'done')}
              </p>
            ))}
        </div>
      )}
    </section>
  );
}
