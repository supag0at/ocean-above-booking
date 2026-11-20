// Event payload builders for harness emits (shapes per @fb/contracts/server).
import { newRunId } from '@fb/contracts/server';

export const newRun = (): string => newRunId();

export const runStarted = (runId: string, inputSeqs: number[], consumedUpToSeq = Math.max(...inputSeqs)) => ({
  type: 'agent.run_started',
  idempotencyKey: `run:${runId}:started`,
  payload: {
    runId,
    inputSeqs,
    consumedUpToSeq,
    lang: 'en',
    today: '2026-11-19',
    profile: { frequentRoutes: [], ticketCount: 0 },
    model: 'deepseek-flash',
    promptVersion: 'p1',
    projectorVersion: 'j1',
    piVersion: '1.5.2',
  },
});

export const runCompleted = (runId: string) => ({
  type: 'agent.run_completed',
  idempotencyKey: `run:${runId}:done`,
  payload: {
    runId,
    endReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0 },
  },
});

export const runFailed = (runId: string) => ({
  type: 'agent.run_failed',
  idempotencyKey: `run:${runId}:done`,
  payload: { runId, code: 'LLM_ERROR', retryable: true },
});

export const reply = (runId: string, n: number, text: string) => ({
  type: 'agent.message',
  idempotencyKey: `msg:m:${runId}:1:${n}`,
  payload: {
    runId,
    attempt: 1,
    n,
    messageKey: `m:${runId}:1:${n}`,
    messageJson: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text }] }),
    piVersion: '1.5.2',
    role: 'assistant',
    hasToolCalls: false,
    viewText: text,
  },
});

export const offered = (runId: string, quoteId: string, toolCallId: string) => ({
  type: 'quote.offered',
  idempotencyKey: `offer:${runId}:${toolCallId}`,
  payload: { runId, quoteId, toolCallId },
});
