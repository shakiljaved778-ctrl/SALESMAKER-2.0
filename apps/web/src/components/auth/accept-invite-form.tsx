'use client';

import { Button, FormField, Input } from '@sm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type SyntheticEvent } from 'react';

import { fieldCodes, postJson } from '../../lib/client-api';
import { rememberSession, type Me } from '../../lib/session';
import { MIN_PASSWORD } from '../../lib/validation';
import { AuthHeader, FormError, useProblemMessage } from './shared';

interface Accepted {
  status: 'ok';
  accessToken: string;
  accessTokenExpiresAt: string;
  user: Me;
}

/**
 * Opened from the invitation email (§6.1): choose a password, and the single-use invitation
 * signs the new user straight in. Google/Microsoft with the invited address works too (sign-in).
 */
export function AcceptInviteForm({
  token,
  workspace,
}: {
  token: string | null;
  workspace: string;
}) {
  const t = useTranslations('auth');
  const router = useRouter();
  const problemMessage = useProblemMessage();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [expired, setExpired] = useState(!token);
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(t('errors.passwordTooShort'));
      return;
    }
    setError(null);
    setPending(true);
    const result = await postJson<Accepted>('/api/auth/invitations/accept', { token, password });
    if (result.ok) {
      rememberSession(result.data);
      router.replace('/home');
      return;
    }
    setPending(false);
    const codes = fieldCodes(result);
    if (codes.token) setExpired(true);
    else if (codes.password === 'breached') setError(t('errors.breachedPassword'));
    else if (codes.password) setError(t('errors.passwordTooShort'));
    else setFormError(problemMessage(result, t('errors.unavailable')));
  };

  const header = (
    <AuthHeader
      title={t('acceptInvite.title', { workspace })}
      subtitle={expired ? undefined : t('acceptInvite.subtitle')}
    />
  );
  if (expired) {
    return (
      <>
        {header}
        <FormError message={t('acceptInvite.expired')} />
        <Button asChild variant="primary">
          <Link href="/sign-in">{t('acceptInvite.signInInstead')}</Link>
        </Button>
      </>
    );
  }
  return (
    <>
      {header}
      <FormError message={formError} />
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <FormField
          label={t('fields.password')}
          helper={t('fields.passwordHelp')}
          error={error ?? undefined}
          required
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </FormField>
        <Button type="submit" variant="primary" disabled={pending}>
          {t('acceptInvite.submit')}
        </Button>
      </form>
      <p className="mt-6 text-body-sm text-fg-secondary">
        {t('acceptInvite.sso')}{' '}
        <Link href="/sign-in" className="text-link">
          {t('acceptInvite.signInInstead')}
        </Link>
      </p>
    </>
  );
}
