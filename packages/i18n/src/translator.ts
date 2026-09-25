import { createTranslator } from 'use-intl/core';

import en from '../messages/en.json' with { type: 'json' };
import enXA from '../messages/en-XA.json' with { type: 'json' };
import { CATALOGUE, DEFAULT_LOCALE, intlLocaleOf, isLocale, type Locale } from './locales.js';

export const catalogues = { en, 'en-XA': enXA } as const;
export type AppMessages = typeof en;

export function messagesFor(locale: Locale): AppMessages {
  return catalogues[CATALOGUE[locale]];
}

/**
 * Server-side translator (emails, API-rendered text). Typed against the English catalogue, so an
 * unknown key is a compile error (golden rule 5).
 */
export function serverTranslator(locale: string = DEFAULT_LOCALE) {
  const resolved: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return createTranslator({ locale: intlLocaleOf(resolved), messages: messagesFor(resolved) });
}
