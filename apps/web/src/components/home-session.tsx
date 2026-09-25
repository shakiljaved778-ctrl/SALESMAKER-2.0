'use client';

import { Banner, Button, EmptyState, Skeleton } from '@sm/ui';
import { Inbox } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { signOut, useSession } from '../lib/session';

/**
 * Signed-in landing until the app shell arrives (T23): proves the session restores from the
 * refresh cookie on a fresh page load, and signs out.
 */
export function HomeSession() {
  const t = useTranslations('shell.home');
  const tc = useTranslations('common');
  const ta = useTranslations('auth.errors');
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    if (session.status === 'signed-out') router.replace('/sign-in');
  }, [session.status, router]);

  if (session.status === 'loading' || session.status === 'signed-out') {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton shape="text" className="w-1/2" />
      </div>
    );
  }
  if (session.status === 'unavailable') return <Banner tone="danger">{ta('unavailable')}</Banner>;

  const hour = new Date().getHours();
  const period = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-title-1 text-fg">
          {t('greeting', { period, name: session.session.user.name })}
        </h1>
        <Button
          variant="secondary"
          onClick={() => {
            void signOut().then(() => {
              router.replace('/sign-in');
            });
          }}
        >
          {tc('actions.signOut')}
        </Button>
      </div>
      <EmptyState icon={<Inbox />} title={t('emptyTitle')} description={t('emptyBody')} />
    </div>
  );
}
