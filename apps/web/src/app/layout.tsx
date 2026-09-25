import { directionOf } from '@sm/i18n';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { readPreferences } from '../lib/preferences';
import { inter, jetbrainsMono } from './fonts';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common');
  return { title: { default: t('productName'), template: `%s · ${t('productName')}` } };
}

export const viewport: Viewport = { colorScheme: 'light dark' };

/**
 * Theme, density, locale and direction are rendered on <html> from preference cookies, so the
 * first paint is already right: no flash and no inline script. `system` resolves in CSS through
 * prefers-color-scheme (tokens.css).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const prefs = readPreferences((name) => store.get(name)?.value);
  const messages = await getMessages();
  return (
    <html
      lang={prefs.locale}
      dir={directionOf(prefs.locale)}
      data-theme={prefs.theme}
      data-density={prefs.density}
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-dvh bg-canvas text-fg">
        <NextIntlClientProvider locale={prefs.locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
