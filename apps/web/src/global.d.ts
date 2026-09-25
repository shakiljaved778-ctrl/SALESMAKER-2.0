import type { AppMessages, Locale } from '@sm/i18n';

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: AppMessages;
  }
}
