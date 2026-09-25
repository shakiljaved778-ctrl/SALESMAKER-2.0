'use client';

import { Banner, Button, FormField, Input } from '@sm/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { fieldCodes, postJson } from '../../lib/client-api';
import { EMAIL, MIN_PASSWORD } from '../../lib/validation';
import { AuthHeader, FormError, useProblemMessage } from './shared';

type VerifyState = 'verifying' | 'done' | 'expired' | 'unavailable';

/** Opened from the verification email: verifies once on load, then points to sign-in. */
export function VerifyEmail({ token }: { token: string | null }) {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const [state, setState] = useState<VerifyState>(token ? 'verifying' : 'expired');
  const [attempt, setAttempt] = useState(0);
  const sent = useRef(-1);

  useEffect(() => {
    // A token is single-use: send it once per attempt (React may run effects twice in dev).
    if (!token || sent.current === attempt) return;
    sent.current = attempt;
    void postJson('/api/auth/verify-email', { token }).then((result) => {
      if (result.ok) setState('done');
      else if (result.status === 400 || result.status === 422) setState('expired');
      else setState('unavailable');
    });
  }, [token, attempt]);

  if (state === 'verifying') {
    return (
      <div role="status" className="text-body text-fg-secondary">
        {t('verifyEmail.verifying')}
      </div>
    );
  }
  if (state === 'done') {
    return (
      <>
        <AuthHeader title={t('verifyEmail.done')} />
        <Button asChild variant="primary">
          <Link href="/sign-in">{t('verifyEmail.continue')}</Link>
        </Button>
      </>
    );
  }
  if (state === 'unavailable') {
    return (
      <>
        <AuthHeader title={t('verifyEmail.title')} />
        <FormError message={t('errors.unavailable')} />
        <Button
          variant="primary"
          onClick={() => {
            setState('verifying');
            setAttempt((n) => n + 1);
          }}
        >
          {tc('actions.retry')}
        </Button>
      </>
    );
  }
  return <ResendForm />;
}

function ResendForm() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError(t('errors.invalidEmail'));
      return;
    }
    setPending(true);
    await postJson('/api/auth/verify-email/resend', { email: email.trim() });
    setPending(false);
    setSent(true);
  };
  return (
    <>
      <AuthHeader title={t('verifyEmail.title')} />
      <FormError message={t('verifyEmail.expired')} />
      {sent ? (
        <Banner tone="info">{t('verifyEmail.resent')}</Banner>
      ) : (
        <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <FormField label={t('fields.email')} error={error ?? undefined} required>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </FormField>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            loadingLabel={t('verifyEmail.resend')}
          >
            {t('verifyEmail.resend')}
          </Button>
        </form>
      )}
      <Link href="/sign-in" className="mt-8 inline-block text-body-sm text-link hover:underline">
        {t('backToSignIn')}
      </Link>
    </>
  );
}

/** Opened from the reset email: choose a new password (breach-checked server-side). */
export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useTranslations('auth');
  const problemMessage = useProblemMessage();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [state, setState] = useState<'form' | 'done' | 'expired'>(token ? 'form' : 'expired');
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(t('errors.passwordTooShort'));
      return;
    }
    setError(null);
    setPending(true);
    const result = await postJson('/api/auth/password/reset', { token, newPassword: password });
    setPending(false);
    if (result.ok) {
      setState('done');
      return;
    }
    const codes = fieldCodes(result);
    if (codes.token) setState('expired');
    else if (codes.newPassword === 'breached') setError(t('errors.breachedPassword'));
    else if (codes.newPassword) setError(t('errors.passwordTooShort'));
    else setFormError(problemMessage(result, t('errors.unavailable')));
  };

  if (state === 'done') {
    return (
      <>
        <AuthHeader title={t('resetPassword.title')} />
        <Banner tone="info" className="mb-6">
          {t('resetPassword.done')}
        </Banner>
        <Button asChild variant="primary">
          <Link href="/sign-in">{t('signIn.submit')}</Link>
        </Button>
      </>
    );
  }
  if (state === 'expired') {
    return (
      <>
        <AuthHeader title={t('resetPassword.title')} />
        <FormError message={t('resetPassword.expired')} />
        <Button asChild variant="primary">
          <Link href="/forgot-password">{t('resetPassword.requestNew')}</Link>
        </Button>
      </>
    );
  }
  return (
    <>
      <AuthHeader title={t('resetPassword.title')} />
      <FormError message={formError} />
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <FormField
          label={t('fields.newPassword')}
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
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          loadingLabel={t('resetPassword.submit')}
        >
          {t('resetPassword.submit')}
        </Button>
      </form>
    </>
  );
}
