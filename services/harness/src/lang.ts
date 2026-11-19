// Run language (A-02 §10, D-43).
import type { Locale, ProfileSnapshot } from '@fb/contracts/server';

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const LATIN = /[A-Za-z]/;

export function langOfText(text: string): Locale | undefined {
  const chars = [...text].filter((c) => !/\s/u.test(c));
  if (chars.length === 0) return undefined;
  const cjk = chars.filter((c) => CJK.test(c)).length / chars.length;
  if (cjk >= 0.3) return 'zh';
  if (cjk < 0.1 && chars.some((c) => LATIN.test(c))) return 'en';
  return undefined;
}

export function chooseLang(input: {
  lastUserText: string;
  profile: ProfileSnapshot;
  previousRunLang: Locale | undefined;
  sessionLocale: Locale;
}): Locale {
  return (
    langOfText(input.lastUserText) ?? input.profile.preferredLanguage ?? input.previousRunLang ?? input.sessionLocale
  );
}
