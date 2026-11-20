import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fb/contracts/web';
import zh from './zh.json';
import en from './en.json';
import { pickLocale } from './index.ts';

describe('i18n tables', () => {
  it('zh and en have exactly the same keys (A-01 §9.6)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it('every error code has copy in both languages (errors are shown via i18n, not server messages)', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(zh, code).toHaveProperty(`error.${code}`);
      expect(en, code).toHaveProperty(`error.${code}`);
    }
  });
  it('the process-area disclaimer is present verbatim', () => {
    expect(zh['process.disclaimer']).toBe('中间过程，不作为报价依据');
    expect(en['process.disclaimer']).toBe('Intermediate steps, not a basis for any quote');
  });
  it('has running/done/failed copy for every tool, plus a fallback', () => {
    for (const tool of [
      'resolve_city',
      'quote_route',
      'offer_booking',
      'list_my_tickets',
      'save_preference',
      'forget_preference',
      'unknown',
    ]) {
      for (const phase of ['running', 'done', 'failed']) expect(zh).toHaveProperty(`process.tool.${tool}.${phase}`);
    }
  });
  it('locale priority: user setting > browser language > zh', () => {
    expect(pickLocale('en', 'zh-CN')).toBe('en');
    expect(pickLocale(null, 'en-US')).toBe('en');
    expect(pickLocale(null, 'fr')).toBe('zh');
    expect(pickLocale(undefined, undefined)).toBe('zh');
  });
});
