import type { TFunction } from 'i18next';
import { ApiRequestError } from '../api/client.ts';

/** User-facing text for an error code (A-01 §4.1: copy comes from the i18n table, never from `message`). */
export function errorText(t: TFunction, code: string | null | undefined): string {
  if (code === 'NETWORK') return t('error.network');
  if (!code || code === 'UNKNOWN') return t('error.UNKNOWN');
  return t(`error.${code}`, { defaultValue: t('error.UNKNOWN') });
}

export function errorTextOf(t: TFunction, err: unknown): string {
  return errorText(t, err instanceof ApiRequestError ? err.code : 'UNKNOWN');
}
