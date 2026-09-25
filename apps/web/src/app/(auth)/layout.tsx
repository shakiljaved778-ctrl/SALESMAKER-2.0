import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { PipelineIllustration } from '../../components/auth/pipeline-illustration';

/**
 * T9 auth template (§9.8): brand panel (Jade 700 → 900) beside a 440 px form panel. The brand
 * panel is decorative context and folds away below the large breakpoint.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('auth.brand');
  const tc = await getTranslations('common');
  return (
    <div className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(440px,40%)]">
      <aside className="hidden flex-col justify-between gap-10 bg-linear-to-br from-brand-from to-brand-to p-12 text-on-brand lg:flex">
        <p className="text-title-3 font-semibold">{tc('productName')}</p>
        <div className="flex max-w-lg flex-col gap-8">
          <PipelineIllustration className="w-full max-w-md text-on-brand" />
          <div className="flex flex-col gap-4">
            <p className="text-title-1">{t('tagline')}</p>
            <ul className="flex flex-col gap-2 text-body text-on-brand-muted">
              <li>{t('points.pipeline')}</li>
              <li>{t('points.teams')}</li>
              <li>{t('points.region')}</li>
            </ul>
          </div>
        </div>
        <span />
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-10">
        <div className="w-full max-w-[440px]">{children}</div>
      </main>
    </div>
  );
}
