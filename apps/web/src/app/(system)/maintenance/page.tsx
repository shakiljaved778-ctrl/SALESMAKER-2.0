import { Button } from '@sm/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SystemPage } from '../../../components/system-page';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('system.maintenance');
  return { title: t('title') };
}

/** Shown when the control plane can't be reached; it never calls it itself. */
export default async function Maintenance() {
  const t = await getTranslations('system.maintenance');
  return (
    <SystemPage
      title={t('title')}
      body={t('body')}
      action={
        <Button asChild variant="primary">
          <a href="/">{t('action')}</a>
        </Button>
      }
    />
  );
}
