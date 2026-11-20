// Run language (A-02 §10, D-43, CONTRACT M-23 ②).
import type { Locale, ProfileSnapshot } from '@fb/contracts/server';

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ᄀ-ᇿ㄰-㆏]/u;
const LATIN = /\p{Script=Latin}/u;

/** CJK share among LETTER characters only (Latin + CJK ideographs, kana, hangul); punctuation, digits, spaces ignored. */
export function cjkRatio(text: string): number | undefined {
  let cjk = 0;
  let latin = 0;
  for (const c of text.normalize('NFKC')) {
    if (CJK.test(c)) cjk++;
    else if (LATIN.test(c)) latin++;
  }
  const total = cjk + latin;
  return total === 0 ? undefined : cjk / total;
}

export function langOfText(text: string): Locale | undefined {
  const r = cjkRatio(text);
  if (r === undefined) return undefined;
  if (r >= 0.3) return 'zh';
  if (r < 0.1) return 'en';
  return undefined;
}

const ASK_EN =
  /(用|请用|使用|改用|换成)\s*英(文|语)(回答|回复|交流|说)?|\b(answer|reply|respond|speak|talk)\s+(to me\s+)?in\s+english\b|\bin english,? please\b/i;
const ASK_ZH =
  /(用|请用|使用|改用|换成)\s*(中文|汉语|普通话)(回答|回复|交流|说)?|\b(answer|reply|respond|speak|talk)\s+(to me\s+)?in\s+chinese\b|\bin chinese,? please\b/i;

/** An explicit language request in the current message ("用英文回答", "answer in English"). */
export function explicitLangRequest(text: string): Locale | undefined {
  const en = ASK_EN.test(text);
  const zh = ASK_ZH.test(text);
  if (en === zh) return undefined;
  return en ? 'en' : 'zh';
}

/**
 * Order (M-23 ②): explicit request in this message → saved preferred_language → CJK ratio → previous run → session
 * locale.
 */
export function chooseLang(input: {
  lastUserText: string;
  profile: ProfileSnapshot;
  previousRunLang: Locale | undefined;
  sessionLocale: Locale;
}): Locale {
  return (
    explicitLangRequest(input.lastUserText) ??
    input.profile.preferredLanguage ??
    langOfText(input.lastUserText) ??
    input.previousRunLang ??
    input.sessionLocale
  );
}
