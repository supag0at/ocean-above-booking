import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Locale } from '@fb/contracts/web';
import zh from './zh.json';
import en from './en.json';

export const resources = { zh: { translation: zh }, en: { translation: en } } as const;

/** Language priority (A-01 §9.6): user setting > browser language > zh. */
export function pickLocale(userLocale?: Locale | null, browserLanguage?: string | null): Locale {
  if (userLocale === 'zh' || userLocale === 'en') return userLocale;
  const b = (browserLanguage ?? '').toLowerCase();
  if (b.startsWith('en')) return 'en';
  return 'zh';
}

export function initI18n(lng: Locale) {
  if (i18next.isInitialized) {
    void i18next.changeLanguage(lng);
    return i18next;
  }
  void i18next.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: 'zh',
    interpolation: { escapeValue: false }, // React escapes text; HTML is never injected
    returnNull: false,
  });
  return i18next;
}

export { i18next };
