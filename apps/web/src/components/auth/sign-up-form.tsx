'use client';

import { intlLocaleOf, isLocale } from '@sm/i18n';
import { Banner, Button, Combobox, FormField, Input, Select } from '@sm/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';

import { fieldCodes, postJson } from '../../lib/client-api';
import { EMAIL, MIN_PASSWORD, SLUG, slugify } from '../../lib/validation';
import { AuthHeader, Divider, FormError, ProviderButtons, useProblemMessage } from './shared';

export interface RegionOption {
  id: string;
  label: string;
}

/** Corporate currencies offered at signup; any ISO 4217 code can be added later in setup. */
const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'AED',
  'SAR',
  'QAR',
  'KWD',
  'BHD',
  'OMR',
  'EGP',
  'INR',
  'PKR',
  'SGD',
  'AUD',
  'CAD',
];

type Field = 'orgName' | 'slug' | 'cellId' | 'name' | 'email' | 'password';
type Errors = Partial<Record<Field | 'form', string>>;

export interface SignUpFormProps {
  regions: RegionOption[];
  baseDomain: string;
  findWorkspaceUrl: string;
  /** From a failed Google/Microsoft attempt: `slug_taken` or `sso_failed`. */
  initialError?: string | undefined;
  initialProvider?: string | undefined;
}

/** Sign up with organisation creation (T9, §7.20a): the organisation, then the owner account. */
export function SignUpForm({
  regions,
  baseDomain,
  findWorkspaceUrl,
  initialError,
  initialProvider,
}: SignUpFormProps) {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const locale = useLocale();
  const problemMessage = useProblemMessage();
  const [org, setOrg] = useState({
    orgName: '',
    slug: '',
    cellId: regions.length === 1 ? (regions[0]?.id ?? '') : '',
    currency: 'USD',
    timezone: 'UTC',
  });
  const [account, setAccount] = useState({ name: '', email: '', password: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<Errors>(() =>
    initialErrors(initialError, initialProvider, t),
  );
  const [pending, setPending] = useState<'password' | 'provider' | null>(null);
  const [created, setCreated] = useState<{ email: string; address: string } | null>(null);
  // One key per distinct submission: a retry of the same details replays the first answer.
  const idempotency = useRef<{ key: string; payload: string } | null>(null);

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) setOrg((o) => ({ ...o, timezone: zone }));
  }, []);

  const currencyOptions = useMemo(() => {
    const names = new Intl.DisplayNames([isLocale(locale) ? intlLocaleOf(locale) : 'en'], {
      type: 'currency',
    });
    return CURRENCIES.map((code) => ({
      value: code,
      label: `${names.of(code) ?? code} (${code})`,
    }));
  }, [locale]);
  const timezoneOptions = useMemo(
    () =>
      Intl.supportedValuesOf('timeZone').map((zone) => ({
        value: zone,
        label: zone.replaceAll('_', ' '),
      })),
    [],
  );

  const address = `${org.slug || slugify(org.orgName) || 'your-team'}.${baseDomain}`;

  const validateOrg = (): Errors => {
    const next: Errors = {};
    if (org.orgName.trim().length < 2) next.orgName = t('errors.required');
    if (!SLUG.test(org.slug)) next.slug = t('errors.slugFormat');
    if (!org.cellId) next.cellId = t('errors.regionRequired');
    return next;
  };

  const keyFor = (payload: unknown) => {
    const serialised = JSON.stringify(payload);
    if (idempotency.current?.payload !== serialised) {
      idempotency.current = { key: crypto.randomUUID(), payload: serialised };
    }
    return idempotency.current.key;
  };

  const applyProblem = (result: Awaited<ReturnType<typeof postJson>>) => {
    const codes = fieldCodes(result);
    const next: Errors = {};
    if (!result.ok && result.status === 409) next.slug = t('errors.slugTaken');
    if (codes.slug) next.slug = t('errors.slugFormat');
    if (codes.password === 'breached') next.password = t('errors.breachedPassword');
    else if (codes.password) next.password = t('errors.passwordTooShort');
    if (codes.email) next.email = t('errors.invalidEmail');
    if (codes.cellId) next.cellId = t('errors.regionRequired');
    if (!Object.keys(next).length) next.form = problemMessage(result, t('errors.unavailable'));
    setErrors(next);
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const next = validateOrg();
    if (account.name.trim().length < 1) next.name = t('errors.required');
    if (!EMAIL.test(account.email.trim())) next.email = t('errors.invalidEmail');
    if (account.password.length < MIN_PASSWORD) next.password = t('errors.passwordTooShort');
    setErrors(next);
    if (Object.keys(next).length) return;
    const payload = {
      ...org,
      orgName: org.orgName.trim(),
      name: account.name.trim(),
      email: account.email.trim(),
      password: account.password,
      locale,
    };
    setPending('password');
    const result = await postJson<{ verificationSentTo: string; slug: string }>(
      '/api/signup',
      payload,
      {
        'idempotency-key': keyFor(payload),
      },
    );
    setPending(null);
    if (result.ok) {
      setCreated({
        email: result.data.verificationSentTo,
        address: `${result.data.slug}.${baseDomain}`,
      });
    } else {
      applyProblem(result);
    }
  };

  const withProvider = async (provider: 'google' | 'microsoft') => {
    const next = validateOrg();
    setErrors(next);
    if (Object.keys(next).length) return;
    const payload = { ...org, orgName: org.orgName.trim(), locale, provider };
    setPending('provider');
    const result = await postJson<{ authorizationUrl: string }>('/api/signup/oidc', payload, {
      'idempotency-key': keyFor(payload),
    });
    if (result.ok) {
      window.location.assign(result.data.authorizationUrl);
      return;
    }
    setPending(null);
    applyProblem(result);
  };

  if (created) {
    return (
      <>
        <AuthHeader
          title={t('verifyEmail.title')}
          subtitle={t('verifyEmail.body', { email: created.email })}
        />
        <Banner tone="info">
          {t('verifyEmail.workspaceAddress', { address: created.address })}
        </Banner>
      </>
    );
  }

  return (
    <>
      <AuthHeader title={t('signUp.title')} subtitle={t('signUp.subtitle')} />
      <FormError message={errors.form ?? null} />
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-3 text-title-3 text-fg">{t('signUp.orgSection')}</legend>
          <FormField label={t('fields.orgName')} error={errors.orgName} required>
            <Input
              autoComplete="organization"
              value={org.orgName}
              onChange={(e) => {
                const orgName = e.target.value;
                setOrg((o) => ({ ...o, orgName, slug: slugEdited ? o.slug : slugify(orgName) }));
              }}
            />
          </FormField>
          <FormField
            label={t('fields.slug')}
            helper={t('fields.slugHelp', { address })}
            error={errors.slug}
            required
          >
            <Input
              value={org.slug}
              spellCheck={false}
              autoCapitalize="none"
              className="font-mono"
              onChange={(e) => {
                setSlugEdited(true);
                setOrg((o) => ({ ...o, slug: e.target.value.toLowerCase() }));
              }}
            />
          </FormField>
          <FormField
            label={t('fields.region')}
            helper={t('fields.regionHelp')}
            error={errors.cellId}
            required
          >
            <Select
              options={regions.map((r) => ({ value: r.id, label: r.label }))}
              value={org.cellId}
              onValueChange={(cellId) => {
                setOrg((o) => ({ ...o, cellId }));
              }}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.currency')} required>
              <Combobox
                options={currencyOptions}
                value={org.currency}
                onValueChange={(currency) => {
                  setOrg((o) => ({ ...o, currency }));
                }}
                placeholder={org.currency}
                searchPlaceholder={tc('search.placeholder')}
                emptyText={tc('search.noResults')}
              />
            </FormField>
            <FormField label={t('fields.timezone')} required>
              <Combobox
                options={timezoneOptions}
                value={org.timezone}
                onValueChange={(timezone) => {
                  setOrg((o) => ({ ...o, timezone }));
                }}
                placeholder={org.timezone}
                searchPlaceholder={tc('search.placeholder')}
                emptyText={tc('search.noResults')}
              />
            </FormField>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-3 text-title-3 text-fg">{t('signUp.accountSection')}</legend>
          <FormField
            label={t('fields.name')}
            helper={t('fields.nameHelp')}
            error={errors.name}
            required
          >
            <Input
              autoComplete="name"
              value={account.name}
              onChange={(e) => {
                setAccount((a) => ({ ...a, name: e.target.value }));
              }}
            />
          </FormField>
          <FormField label={t('fields.email')} error={errors.email} required>
            <Input
              type="email"
              autoComplete="email"
              value={account.email}
              onChange={(e) => {
                setAccount((a) => ({ ...a, email: e.target.value }));
              }}
            />
          </FormField>
          <FormField
            label={t('fields.password')}
            helper={t('fields.passwordHelp')}
            error={errors.password}
            required
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={account.password}
              onChange={(e) => {
                setAccount((a) => ({ ...a, password: e.target.value }));
              }}
            />
          </FormField>
        </fieldset>

        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            variant="primary"
            loading={pending === 'password'}
            disabled={pending !== null}
            loadingLabel={t('signUp.submit')}
          >
            {t('signUp.submit')}
          </Button>
          <p className="text-caption text-fg-secondary">{t('signUp.legal')}</p>
        </div>
      </form>
      <Divider label={t('signIn.orContinueWith')} />
      <ProviderButtons disabled={pending !== null} onChoose={(p) => void withProvider(p)} />
      <p className="mt-2 text-caption text-fg-secondary">{t('signUp.providerHint')}</p>
      <p className="mt-8 text-body-sm">
        <a href={findWorkspaceUrl} className="text-link hover:underline">
          {t('signUp.haveAccount')}
        </a>
      </p>
    </>
  );
}

function initialErrors(
  error: string | undefined,
  provider: string | undefined,
  t: ReturnType<typeof useTranslations<'auth'>>,
): Errors {
  if (error === 'slug_taken') return { slug: t('errors.slugTaken') };
  if (error === 'sso_failed') {
    const name = provider === 'microsoft' ? t('providers.microsoft') : t('providers.google');
    return { form: t('sso.failed', { provider: name }) };
  }
  return {};
}
