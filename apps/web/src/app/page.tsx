import { Card } from '@sm/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requestWorkspace } from '../server/request-tenant';

export const dynamic = 'force-dynamic';

/** Entry point per host: the apex introduces the product, a workspace host greets its team. */
export default async function Home() {
  const workspace = await requestWorkspace();
  if (workspace.kind === 'unknown') notFound();
  const t = await getTranslations();
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md p-8">
        <p className="text-caption font-semibold tracking-wide text-primary uppercase">
          {t('common.productName')}
        </p>
        <h1 className="mt-2 text-title-2 text-fg">
          {workspace.kind === 'workspace'
            ? t('auth.signIn.title', { workspace: workspace.tenant.name })
            : t('auth.signUp.title')}
        </h1>
        <p className="mt-1 text-body text-fg-secondary">{t('auth.brand.tagline')}</p>
      </Card>
    </main>
  );
}
