'use client';

import { Button } from '@sm/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { AuthHeader, FormError } from './shared';

/**
 * SSO redirect (T9): says where the browser is going, then goes. A failed round trip comes back
 * here with `failed` set and offers a retry or the password form.
 */
export function SsoRedirect({
  provider,
  failed,
}: {
  provider: 'google' | 'microsoft';
  failed: string | null;
}) {
  const t = useTranslations('auth');
  const name = t(`providers.${provider}`);
  const start = `/auth/start/${provider}`;

  useEffect(() => {
    if (!failed) window.location.assign(start);
  }, [failed, start]);

  if (!failed) {
    return (
      <div role="status" className="text-body text-fg-secondary">
        {t('sso.redirecting', { provider: name })}
      </div>
    );
  }
  return (
    <>
      <AuthHeader title={t('sso.title', { provider: name })} />
      <FormError
        message={failed === 'no_account' ? t('sso.noAccount') : t('sso.failed', { provider: name })}
      />
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          onClick={() => {
            window.location.assign(start);
          }}
        >
          {t(`signIn.${provider}`)}
        </Button>
        <Button asChild variant="secondary">
          <Link href="/sign-in">{t('sso.usePassword')}</Link>
        </Button>
      </div>
    </>
  );
}
