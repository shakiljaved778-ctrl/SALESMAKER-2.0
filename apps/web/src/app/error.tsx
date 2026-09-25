'use client';

import { Button } from '@sm/ui';
import { useTranslations } from 'next-intl';

import { SystemPage } from '../components/system-page';

/** 500 (§9.15): the digest is the reference support can find in the logs. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('system.serverError');
  return (
    <SystemPage
      code="500"
      title={t('title')}
      body={t('body', { traceId: error.digest ?? '—' })}
      action={
        <Button variant="primary" onClick={reset}>
          {t('action')}
        </Button>
      }
    />
  );
}
