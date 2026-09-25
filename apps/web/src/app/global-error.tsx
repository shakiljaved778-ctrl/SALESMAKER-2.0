'use client';

import { serverTranslator } from '@sm/i18n';

import './globals.css';

/**
 * Last resort when the root layout itself fails: no providers are available, so it formats
 * from the English catalogue directly.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = serverTranslator('en');
  return (
    <html lang="en" dir="ltr" data-theme="system" data-density="default">
      <body className="min-h-dvh bg-canvas text-fg">
        <main className="flex min-h-dvh items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <h1 className="text-title-1">{t('system.serverError.title')}</h1>
            <p className="text-body text-fg-secondary">
              {t('system.serverError.body', { traceId: error.digest ?? '—' })}
            </p>
            <button
              type="button"
              onClick={reset}
              className="h-[var(--control-height)] rounded-sm bg-primary px-3 text-body text-on-primary"
            >
              {t('system.serverError.action')}
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
