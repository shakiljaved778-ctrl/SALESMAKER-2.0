import { Button } from '@sm/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { SystemPage } from '../components/system-page';

export default async function NotFound() {
  const t = await getTranslations('system.notFound');
  return (
    <SystemPage
      code="404"
      title={t('title')}
      body={t('body')}
      action={
        <Button asChild variant="primary">
          <Link href="/">{t('action')}</Link>
        </Button>
      }
    />
  );
}
