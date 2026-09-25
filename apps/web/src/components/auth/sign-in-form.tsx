'use client';

import { Button, FormField, Input } from '@sm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { fieldCodes, postJson, type ApiResult } from '../../lib/client-api';
import { rememberSession, type Me } from '../../lib/session';
import { EMAIL } from '../../lib/validation';
import { AuthHeader, Divider, FormError, ProviderButtons, useProblemMessage } from './shared';

type LoginResult =
  | { status: 'ok'; accessToken: string; accessTokenExpiresAt: string; user: Me }
  | { status: 'mfa_required'; mfaToken: string; expiresAt: string };

export interface SignInFormProps {
  workspace: string;
  signUpUrl: string;
  findWorkspaceUrl: string;
}

/** Sign in (T9): password, then the two-step challenge when required; or Google/Microsoft. */
export function SignInForm({ workspace, signUpUrl, findWorkspaceUrl }: SignInFormProps) {
  const t = useTranslations('auth');
  const router = useRouter();
  const problemMessage = useProblemMessage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [pending, setPending] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [notVerified, setNotVerified] = useState(false);

  // A Google/Microsoft sign-in that needs a second factor lands here with the token in the
  // fragment (never sent to a server); take it and clean the address bar.
  useEffect(() => {
    const match = /^#mfa=(.+)$/.exec(window.location.hash);
    if (match?.[1]) {
      setMfaToken(decodeURIComponent(match[1]));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const finish = (result: ApiResult<LoginResult>) => {
    if (!result.ok) return false;
    if (result.data.status === 'mfa_required') {
      setMfaToken(result.data.mfaToken);
      return true;
    }
    rememberSession(result.data);
    router.replace('/home');
    return true;
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL.test(email.trim())) next.email = t('errors.invalidEmail');
    if (!password) next.password = t('errors.required');
    setErrors(next);
    setNotVerified(false);
    if (next.email || next.password) return;
    setPending(true);
    const result = await postJson<LoginResult>('/api/auth/login', {
      email: email.trim(),
      password,
    });
    setPending(false);
    if (finish(result) || result.ok) return;
    if (result.problem?.code === 'email_not_verified') {
      setNotVerified(true);
      setErrors({ form: t('errors.emailNotVerified') });
    } else {
      setErrors({ form: problemMessage(result, t('errors.invalidCredentials')) });
    }
  };

  if (mfaToken) {
    return (
      <MfaStep
        mfaToken={mfaToken}
        onDone={finish}
        onRestart={() => {
          setMfaToken(null);
          setPassword('');
        }}
      />
    );
  }

  return (
    <>
      <AuthHeader title={t('signIn.title', { workspace })} />
      <FormError message={errors.form ?? null} />
      {notVerified ? <ResendVerification email={email.trim()} /> : null}
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <FormField label={t('fields.email')} error={errors.email} required>
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </FormField>
        <FormField label={t('fields.password')} error={errors.password} required>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </FormField>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-body-sm text-link hover:underline">
            {t('signIn.forgot')}
          </Link>
        </div>
        <Button type="submit" variant="primary" loading={pending} loadingLabel={t('signIn.submit')}>
          {t('signIn.submit')}
        </Button>
      </form>
      <Divider label={t('signIn.orContinueWith')} />
      <ProviderButtons
        disabled={pending}
        onChoose={(provider) => {
          router.push(`/sso/${provider}`);
        }}
      />
      <div className="mt-8 flex flex-col gap-2 text-body-sm">
        <a href={findWorkspaceUrl} className="text-link hover:underline">
          {t('signIn.otherWorkspace')}
        </a>
        <a href={signUpUrl} className="text-link hover:underline">
          {t('signIn.noAccount')}
        </a>
      </div>
    </>
  );
}

function ResendVerification({ email }: { email: string }) {
  const t = useTranslations('auth.verifyEmail');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  if (state === 'sent') return <p className="mb-4 text-body-sm text-fg-secondary">{t('resent')}</p>;
  return (
    <Button
      type="button"
      variant="link"
      className="mb-4"
      loading={state === 'sending'}
      onClick={() => {
        setState('sending');
        void postJson('/api/auth/verify-email/resend', { email }).then(() => {
          setState('sent');
        });
      }}
    >
      {t('resend')}
    </Button>
  );
}

function MfaStep({
  mfaToken,
  onDone,
  onRestart,
}: {
  mfaToken: string;
  onDone: (result: ApiResult<LoginResult>) => boolean;
  onRestart: () => void;
}) {
  const t = useTranslations('auth');
  const problemMessage = useProblemMessage();
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    const valid =
      mode === 'code' ? /^\d{6}$/.test(trimmed) : /^[a-z2-7]{4}-[a-z2-7]{4}$/i.test(trimmed);
    if (!valid) {
      setError(t('errors.invalidCode'));
      return;
    }
    setPending(true);
    const result = await postJson<LoginResult>(
      '/api/auth/mfa',
      mode === 'code' ? { mfaToken, code: trimmed } : { mfaToken, recoveryCode: trimmed },
    );
    setPending(false);
    if (onDone(result) || result.ok) return;
    if (result.status === 401) {
      setExpired(true);
      return;
    }
    const codes = fieldCodes(result);
    setError(
      codes.code || codes.recoveryCode
        ? t('errors.invalidCode')
        : problemMessage(result, t('errors.invalidCode')),
    );
  };

  if (expired) {
    return (
      <>
        <AuthHeader title={t('mfa.title')} />
        <FormError message={t('mfa.expired')} />
        <Button variant="primary" onClick={onRestart}>
          {t('mfa.startOver')}
        </Button>
      </>
    );
  }

  return (
    <>
      <AuthHeader title={t('mfa.title')} subtitle={mode === 'code' ? t('mfa.body') : undefined} />
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <FormField
          label={mode === 'code' ? t('fields.totpCode') : t('fields.recoveryCode')}
          error={error ?? undefined}
          required
        >
          <Input
            key={mode}
            autoFocus
            autoComplete="one-time-code"
            inputMode={mode === 'code' ? 'numeric' : 'text'}
            className="tabular font-mono"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </FormField>
        <Button type="submit" variant="primary" loading={pending} loadingLabel={t('mfa.submit')}>
          {t('mfa.submit')}
        </Button>
      </form>
      <div className="mt-6 flex flex-col items-start gap-2">
        <Button
          variant="link"
          onClick={() => {
            setMode(mode === 'code' ? 'recovery' : 'code');
            setValue('');
            setError(null);
          }}
        >
          {mode === 'code' ? t('mfa.useRecovery') : t('mfa.useCode')}
        </Button>
        <Button variant="link" onClick={onRestart}>
          {t('backToSignIn')}
        </Button>
      </div>
    </>
  );
}
