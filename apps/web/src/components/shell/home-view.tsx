'use client';

import { Button, EmptyState, Skeleton } from '@sm/ui';
import { Upload } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useShell } from './app-shell';

type Period = 'morning' | 'afternoon' | 'evening';

/** Home (P00): greeting and a teaching empty state; the queue and widgets arrive with P03/P04. */
export function HomeView() {
  const t = useTranslations('shell.home');
  const { user } = useShell();
  // Time of day comes from the viewer's clock, after hydration.
  const [period, setPeriod] = useState<Period | null>(null);
  useEffect(() => {
    const hour = new Date().getHours();
    setPeriod(hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening');
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 p-[var(--page-padding)]">
      {user && period ? (
        <h1 className="text-title-1 text-fg">{t('greeting', { period, name: user.name })}</h1>
      ) : (
        <div aria-busy="true">
          <Skeleton className="h-8 w-80 max-w-full" />
        </div>
      )}
      <EmptyState
        icon={<Upload />}
        title={t('emptyTitle')}
        description={t('emptyBody')}
        action={
          <Button asChild variant="primary">
            <Link href="/leads">{t('emptyAction')}</Link>
          </Button>
        }
      />
    </div>
  );
}
