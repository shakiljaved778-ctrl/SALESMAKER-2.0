import { Button } from '@sm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { SystemPage } from '../../../components/system-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('system.forbidden');
  return { title: t('title') };
}

/** 403 (§6.2): where permission checks send people; "Request access" goes to Home until P01. */
export default async function Forbidden() {
  const t = await getTranslations('system.forbidden');
  return (
    <SystemPage
      code="403"
      title={t('title')}
      body={t('body')}
      action={
        <Button asChild variant="primary">
          <Link href="/home">{t('action')}</Link>
        </Button>
      }
    />
  );
}
