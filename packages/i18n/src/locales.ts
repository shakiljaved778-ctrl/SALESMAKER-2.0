/**
 * Locales (§9.12). v1 ships English only. Two pseudo-locales prove the UI is ready for more:
 * `en-XA` (accented, ~30% longer: catches truncation and hard-coded strings) and `ar-XB`
 * (English strings laid out right-to-left: proves logical CSS and icon mirroring).
 */
export const LOCALES = ['en', 'en-XA', 'ar-XB'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Which catalogue each locale reads. ar-XB deliberately reuses English text. */
export const CATALOGUE: Record<Locale, 'en' | 'en-XA'> = {
  en: 'en',
  'en-XA': 'en-XA',
  'ar-XB': 'en',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Text direction for the `dir` attribute on <html>. */
export function directionOf(locale: string): 'ltr' | 'rtl' {
  const language = locale.split('-')[0]?.toLowerCase() ?? '';
  return ['ar', 'he', 'fa', 'ur'].includes(language) ? 'rtl' : 'ltr';
}

/** BCP 47 tag to hand to Intl formatters (pseudo-locales format numbers and dates like English). */
export function intlLocaleOf(locale: Locale): string {
  return locale === 'en' ? 'en' : 'en';
}
