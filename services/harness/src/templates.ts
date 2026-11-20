// Template messages (A-02 §12.1). The zh/en copy is harness-local (CONTRACT M-24 ⑦); the contract carries TEMPLATE_IDS.
import type { Ending, ErrorCode, Locale, TemplateId } from '@fb/contracts/server';

export const TEMPLATE_TEXT: Readonly<Record<TemplateId, Readonly<Record<Locale, string>>>> = {
  llm_unavailable: {
    zh: '抱歉，助手暂时无法回复，请稍后再试。',
    en: 'Sorry, the assistant is temporarily unavailable. Please try again shortly.',
  },
  run_timeout: {
    zh: '抱歉，这次处理时间过长，已经停止。请再发一次您的请求。',
    en: 'Sorry, this took too long and was stopped. Please send your request again.',
  },
  restart_limit: {
    zh: '抱歉，处理过程中多次中断。请再发一次您的请求。',
    en: 'Sorry, processing was interrupted repeatedly. Please send your request again.',
  },
  context_corrupt: {
    zh: '抱歉，这段对话的记录出现了问题，建议您新开一个对话。',
    en: 'Sorry, something went wrong with this conversation. Please start a new conversation.',
  },
  turn_limit: {
    zh: '这次请求需要的步骤太多，我先停在这里。请告诉我您最想先完成哪一步。',
    en: 'This request needed too many steps, so I stopped here. Please tell me which part you want first.',
  },
  guard_fallback: {
    zh: '路线详情和价格请以上方报价卡为准。',
    en: 'Please refer to the quote card above for route details and price.',
  },
};

/** The ending each template stands for when written by an ending path (A-02 §3.5 / §12.1). */
export function templateEnding(id: TemplateId, code?: Ending): Ending {
  if (code !== undefined) return code;
  switch (id) {
    case 'guard_fallback':
      return { kind: 'completed', endReason: 'stop' };
    case 'turn_limit':
      return { kind: 'completed', endReason: 'turn_limit' };
    case 'run_timeout':
      return failed('RUN_TIMEOUT', true);
    case 'restart_limit':
      return failed('RESTART_LIMIT', false);
    case 'context_corrupt':
      return failed('CONTEXT_CORRUPT', false);
    case 'llm_unavailable':
      return failed('LLM_ERROR', true);
  }
}

/** Ending of a failed run. (The contract's ErrorCode union is too wide for TS to narrow here, hence the cast.) */
export function failed(code: ErrorCode, retryable: boolean): Ending {
  return { kind: 'failed', code, retryable } as unknown as Ending;
}
