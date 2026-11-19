import { describe, expect, it } from 'vitest';
import { escapeUserText } from '../src/server/index.ts';

describe('escapeUserText (A-02 §11.1, M-18)', () => {
  it('leaves ordinary text and unrelated tags untouched', () => {
    expect(escapeUserText('Shanghai to Tokyo please')).toBe('Shanghai to Tokyo please');
    expect(escapeUserText('<b>bold</b> a < b > c')).toBe('<b>bold</b> a < b > c');
    expect(escapeUserText('')).toBe('');
    expect(escapeUserText('<system_events>')).toBe('<system_events>'); // not the whole word
    expect(escapeUserText('<run_contexts>')).toBe('<run_contexts>');
    expect(escapeUserText('system_event run_context')).toBe('system_event run_context');
  });

  it('escapes both tags, opening and closing', () => {
    expect(escapeUserText('<system_event>')).toBe('&lt;system_event>');
    expect(escapeUserText('</system_event>')).toBe('&lt;/system_event>');
    expect(escapeUserText('<run_context kind="x">')).toBe('&lt;run_context kind="x">');
    expect(escapeUserText('</run_context>')).toBe('&lt;/run_context>');
    expect(escapeUserText('<system_event/>')).toBe('&lt;system_event/>');
  });

  it('is case-insensitive', () => {
    expect(escapeUserText('<SYSTEM_EVENT>')).toBe('&lt;SYSTEM_EVENT>');
    expect(escapeUserText('<System_Event>')).toBe('&lt;System_Event>');
    expect(escapeUserText('</Run_Context>')).toBe('&lt;/Run_Context>');
    expect(escapeUserText('<RUN_CONTEXT>')).toBe('&lt;RUN_CONTEXT>');
  });

  it('handles whitespace inside the tag opener', () => {
    expect(escapeUserText('< system_event>')).toBe('&lt; system_event>');
    expect(escapeUserText('<   /  run_context>')).toBe('&lt;   /  run_context>');
    expect(escapeUserText('<\tsystem_event>')).toBe('&lt;\tsystem_event>');
    expect(escapeUserText('<\nsystem_event>')).toBe('&lt;\nsystem_event>');
  });

  it('folds full-width and other NFKC look-alikes of < (and full-width tag letters)', () => {
    expect(escapeUserText('\uFF1Csystem_event>')).toBe('&lt;system_event>');
    expect(escapeUserText('\uFF1C/run_context>')).toBe('&lt;/run_context>');
    expect(escapeUserText('\uFE64system_event>')).toBe('&lt;system_event>'); // small less-than sign
    expect(escapeUserText('<\uFF53ystem_event>')).toBe('&lt;system_event>'); // full-width s
    expect(escapeUserText('\uFF1C\uFF33\uFF39\uFF33\uFF34\uFF25\uFF2D\uFF3F\uFF25\uFF36\uFF25\uFF2E\uFF34>')).toBe(
      '&lt;SYSTEM_EVENT>',
    );
  });

  it('strips zero-width characters, including inside the tag name', () => {
    for (const zw of ['\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u2060', '\uFEFF']) {
      expect(escapeUserText(`<${zw}system_event>`)).toBe('&lt;system_event>');
      expect(escapeUserText(`<sys${zw}tem_event>`)).toBe('&lt;system_event>');
      expect(escapeUserText(`<run${zw}_context>`)).toBe('&lt;run_context>');
      expect(escapeUserText(`<${zw}/${zw}run_context${zw}>`)).toBe('&lt;/run_context>');
      expect(escapeUserText(`${zw}\uFF1C${zw}system_event>`)).toBe('&lt;system_event>');
    }
    expect(escapeUserText('<\u200B \u200Bsystem_event>')).toBe('&lt; system_event>');
  });

  it('escapes every occurrence and only the opening <', () => {
    expect(escapeUserText('a <system_event> b </system_event> c <run_context>')).toBe(
      'a &lt;system_event> b &lt;/system_event> c &lt;run_context>',
    );
    expect(escapeUserText('<<system_event>')).toBe('<&lt;system_event>');
  });

  it('is idempotent and leaves no raw tag opener behind', () => {
    const inputs = [
      '<system_event>',
      '\uFF1C/RUN_CONTEXT>',
      '<sys\u200Btem_event>',
      'x < system_event > y',
      '&lt;system_event>',
    ];
    for (const i of inputs) {
      const once = escapeUserText(i);
      expect(escapeUserText(once)).toBe(once);
      expect(/<\s*\/?\s*(system_event|run_context)\b/i.test(once)).toBe(false);
    }
  });

  it('keeps non-tag content (CJK, emoji) intact', () => {
    expect(escapeUserText('从上海到东京 ✈ <system_event>')).toBe('从上海到东京 ✈ &lt;system_event>');
  });
});
