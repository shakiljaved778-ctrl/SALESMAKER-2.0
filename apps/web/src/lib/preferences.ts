import { DEFAULT_LOCALE, isLocale, type Locale } from '@sm/i18n';

export const THEMES = ['light', 'dark', 'system'] as const;
export const DENSITIES = ['comfortable', 'default', 'compact'] as const;
export type Theme = (typeof THEMES)[number];
export type Density = (typeof DENSITIES)[number];

/** Display preferences travel in plain cookies so the server renders them without a flash. */
export const PREFERENCE_COOKIES = {
  theme: 'sm_theme',
  density: 'sm_density',
  locale: 'sm_locale',
} as const;

export interface Preferences {
  theme: Theme;
  density: Density;
  locale: Locale;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Unknown or tampered values fall back to defaults; nothing from a cookie reaches markup unchecked. */
export function readPreferences(get: (name: string) => string | undefined): Preferences {
  const locale = get(PREFERENCE_COOKIES.locale);
  return {
    theme: oneOf(THEMES, get(PREFERENCE_COOKIES.theme), 'system'),
    density: oneOf(DENSITIES, get(PREFERENCE_COOKIES.density), 'default'),
    locale: isLocale(locale) ? locale : DEFAULT_LOCALE,
  };
}
