'use client';

import { Banner, Button, FormField, Input } from '@sm/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type SyntheticEvent } from 'react';

import { postJson } from '../../lib/client-api';
import { EMAIL } from '../../lib/validation';
import { AuthHeader, FormError, useProblemMessage } from './shared';

/**
 * One email field that always ends in the same "sent" state, whatever the address: forgot
 * password and find-my-workspaces must never reveal whether an account exists.
 */
function EmailOnlyForm({
  endpoint,
  title,
  body,
  submitLabel,
  sentMessage,
  footer,
}: {
  endpoint: string;
  title: string;
  body: string;
  submitLabel: string;
  sentMessage: (email: string) => string;
  footer: React.ReactNode;
}) {
  const t = useTranslations('auth');
  const problemMessage = useProblemMessage();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setError(t('errors.invalidEmail'));
      return;
    }
    setError(null);
    setPending(true);
    const result = await postJson(endpoint, { email: value });
    setPending(false);
    if (result.ok) setSentTo(value);
    else setFormError(problemMessage(result, t('errors.unavailable')));
  };

  if (sentTo) {
    return (
      <>
        <AuthHeader title={title} />
        <Banner tone="info" className="mb-6">
          {sentMessage(sentTo)}
        </Banner>
        {footer}
      </>
    );
  }
  return (
    <>
      <AuthHeader title={title} subtitle={body} />
      <FormError message={formError} />
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
        <Button type="submit" variant="primary" loading={pending} loadingLabel={submitLabel}>
          {submitLabel}
        </Button>
      </form>
      <div className="mt-8">{footer}</div>
    </>
  );
}

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  return (
    <EmailOnlyForm
      endpoint="/api/auth/password/forgot"
      title={t('forgotPassword.title')}
      body={t('forgotPassword.body')}
      submitLabel={t('forgotPassword.submit')}
      sentMessage={(email) => t('forgotPassword.sent', { email })}
      footer={
        <Link href="/sign-in" className="text-body-sm text-link hover:underline">
          {t('backToSignIn')}
        </Link>
      }
    />
  );
}

export function FindWorkspaceForm({ signUpUrl }: { signUpUrl: string }) {
  const t = useTranslations('auth');
  return (
    <EmailOnlyForm
      endpoint="/api/workspaces/find"
      title={t('findWorkspace.title')}
      body={t('findWorkspace.body')}
      submitLabel={t('findWorkspace.submit')}
      sentMessage={(email) => t('findWorkspace.sent', { email })}
      footer={
        <a href={signUpUrl} className="text-body-sm text-link hover:underline">
          {t('findWorkspace.createInstead')}
        </a>
      }
    />
  );
}
