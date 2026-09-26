'use client';

import type { MeResponse, SessionSummary } from '@sm/contracts';
import { LOCALES, type Locale } from '@sm/i18n';
import {
  Banner,
  Button,
  Combobox,
  Dialog,
  FormField,
  Input,
  Select,
  Skeleton,
  StatusChip,
  cn,
  useToast,
} from '@sm/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { encode } from 'uqr';
import type { z } from 'zod';

import { fieldCodes, type ApiResult } from '../../lib/client-api';
import { cellApi } from '../../lib/cell-api';
import { applyDisplay, writePreferenceCookie } from '../../lib/display';
import {
  PREFERENCE_COOKIES,
  THEMES,
  DENSITIES,
  type Density,
  type Theme,
} from '../../lib/preferences';
import { MIN_PASSWORD } from '../../lib/validation';
import { useShell } from '../shell/app-shell';

type Me = z.infer<typeof MeResponse>;
type Session = z.infer<typeof SessionSummary>;

const SECTIONS = ['profile', 'display', 'security'] as const;

/** Personal settings (§9): Profile, Display and Security, each deep-linkable. */
export function SettingsShell({ children }: { children: ReactNode }) {
  const t = useTranslations('settings');
  const pathname = usePathname();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-[var(--page-padding)] md:flex-row">
      <nav aria-label={t('nav')} className="flex shrink-0 flex-col gap-1 md:w-48">
        <p className="px-2 pb-2 text-title-3 text-fg">{t('title')}</p>
        {SECTIONS.map((s) => {
          const href = `/settings/${s}`;
          return (
            <Link
              key={s}
              href={href}
              aria-current={pathname === href ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center rounded-sm px-2 text-body-sm text-fg hover:bg-hover',
                'aria-[current=page]:bg-subtle aria-[current=page]:font-medium',
              )}
            >
              {t(`sections.${s}`)}
            </Link>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 border-b border-line pb-8 last:border-b-0">
      <div>
        <h2 className="text-title-3 text-fg">{title}</h2>
        {description ? <p className="text-body-sm text-fg-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The signed-in user, loaded fresh (the shell's copy may predate a change made here). */
function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    void cellApi<Me>('GET', '/v1/me').then((r) => {
      if (r.ok) setMe(r.data);
    });
  }, []);
  return [me, setMe] as const;
}

const Loading = () => (
  <div aria-busy="true" className="flex flex-col gap-3">
    <Skeleton className="h-8 w-60" />
    <Skeleton className="h-32 w-full" />
  </div>
);

// ── Profile ────────────────────────────────────────────────────────────────────────────────
export function ProfileSettings() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const toast = useToast();
  const [me, setMe] = useMe();
  const [draft, setDraft] = useState({ name: '', title: '', phone: '' });
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (me) setDraft({ name: me.name, title: me.title ?? '', phone: me.phone ?? '' });
  }, [me]);
  if (!me) return <Loading />;
  const dirty =
    draft.name !== me.name || draft.title !== (me.title ?? '') || draft.phone !== (me.phone ?? '');
  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    setPending(true);
    const result = await cellApi<Me>('PATCH', '/v1/me/profile', {
      name: draft.name.trim(),
      title: draft.title.trim() || null,
      phone: draft.phone.trim() || null,
    });
    setPending(false);
    if (!result.ok) {
      toast({ tone: 'error', title: t('unavailable') });
      return;
    }
    setMe(result.data);
    toast({ tone: 'success', title: t('saved') });
  };
  return (
    <Section title={t('sections.profile')} description={t('profile.description')}>
      <form noValidate onSubmit={(e) => void save(e)} className="flex max-w-lg flex-col gap-4">
        <FormField label={t('profile.name')} required>
          <Input
            value={draft.name}
            autoComplete="name"
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
            }}
          />
        </FormField>
        <FormField label={t('profile.email')} helper={t('profile.emailHelp')} disabled>
          <Input value={me.email} readOnly />
        </FormField>
        <FormField label={t('profile.title')}>
          <Input
            value={draft.title}
            autoComplete="organization-title"
            onChange={(e) => {
              setDraft({ ...draft, title: e.target.value });
            }}
          />
        </FormField>
        <FormField label={t('profile.phone')}>
          <Input
            type="tel"
            value={draft.phone}
            autoComplete="tel"
            onChange={(e) => {
              setDraft({ ...draft, phone: e.target.value });
            }}
          />
        </FormField>
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          disabled={!dirty || pending || !draft.name.trim()}
        >
          {tc('actions.save')}
        </Button>
      </form>
    </Section>
  );
}

// ── Display ────────────────────────────────────────────────────────────────────────────────
const LOCALE_KEY: Record<Locale, 'en' | 'enXa' | 'arXb'> = {
  en: 'en',
  'en-XA': 'enXa',
  'ar-XB': 'arXb',
};
const THEME_LABEL = { light: 'themeLight', dark: 'themeDark', system: 'themeSystem' } as const;
const DENSITY_LABEL = {
  comfortable: 'densityComfortable',
  default: 'densityDefault',
  compact: 'densityCompact',
} as const;

export function DisplaySettings() {
  const t = useTranslations('settings');
  const td = useTranslations('shell.display');
  const common = useTranslations('common');
  const toast = useToast();
  const [me, setMe] = useMe();
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  if (!me) return <Loading />;
  const save = async (patch: Record<string, string | null>) => {
    const result = await cellApi<Me>('PATCH', '/v1/me/preferences', patch);
    if (!result.ok) {
      toast({ tone: 'error', title: t('unavailable') });
      return false;
    }
    setMe(result.data);
    toast({ tone: 'success', title: t('saved') });
    return true;
  };
  return (
    <Section title={t('sections.display')} description={t('display.description')}>
      <div className="flex max-w-lg flex-col gap-4">
        <FormField label={td('theme')}>
          <Select
            value={me.theme}
            onValueChange={(v) => {
              applyDisplay({ theme: v as Theme }, false);
              void save({ theme: v });
            }}
            options={THEMES.map((v) => ({ value: v, label: td(THEME_LABEL[v]) }))}
          />
        </FormField>
        <FormField label={td('density')}>
          <Select
            value={me.density}
            onValueChange={(v) => {
              applyDisplay({ density: v as Density }, false);
              void save({ density: v });
            }}
            options={DENSITIES.map((v) => ({ value: v, label: td(DENSITY_LABEL[v]) }))}
          />
        </FormField>
        <FormField label={t('display.language')} helper={t('display.languageNote')}>
          <Select
            value={me.locale ?? 'en'}
            onValueChange={(v) => {
              void save({ locale: v }).then((ok) => {
                if (!ok) return;
                writePreferenceCookie(PREFERENCE_COOKIES.locale, v);
                window.location.reload();
              });
            }}
            options={LOCALES.map((l) => ({
              value: l,
              label: t(`display.locales.${LOCALE_KEY[l]}`),
            }))}
          />
        </FormField>
        <FormField label={t('display.timezone')} helper={t('display.timezoneHelp')}>
          <Combobox
            options={[
              { value: '', label: t('display.timezoneDefault') },
              ...zones.map((z) => ({ value: z, label: z.replaceAll('_', ' ') })),
            ]}
            value={me.timezone ?? ''}
            onValueChange={(v) => void save({ timezone: v || null })}
            placeholder={t('display.timezone')}
            searchPlaceholder={common('search.placeholder')}
            emptyText={common('search.noResults')}
          />
        </FormField>
      </div>
    </Section>
  );
}

// ── Security ───────────────────────────────────────────────────────────────────────────────
export function SecuritySettings() {
  const [me, setMe] = useMe();
  if (!me) return <Loading />;
  return (
    <div className="flex flex-col gap-8">
      <PasswordSection />
      <MfaSection
        enabled={me.mfaEnabled}
        onChange={(enabled) => {
          setMe({ ...me, mfaEnabled: enabled });
        }}
      />
      <SessionsSection />
    </div>
  );
}

function PasswordSection() {
  const t = useTranslations('settings.security');
  const ta = useTranslations('auth');
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({});
  const [pending, setPending] = useState(false);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setErrors({ next: ta('errors.passwordTooShort') });
      return;
    }
    setPending(true);
    const result = await cellApi('POST', '/v1/me/password', {
      currentPassword: current,
      newPassword: next,
    });
    setPending(false);
    if (result.ok) {
      setCurrent('');
      setNext('');
      setErrors({});
      toast({ tone: 'success', title: t('passwordChanged') });
      return;
    }
    const codes = fieldCodes(result);
    if (codes.currentPassword) setErrors({ current: t('wrongPassword') });
    else if (codes.password === 'breached') setErrors({ next: ta('errors.breachedPassword') });
    else if (codes.newPassword) setErrors({ next: ta('errors.passwordTooShort') });
    else if (result.status === 409) setErrors({ form: t('noPassword') });
    else setErrors({ form: ta('errors.unavailable') });
  };
  return (
    <Section title={t('passwordTitle')}>
      <form noValidate onSubmit={(e) => void submit(e)} className="flex max-w-lg flex-col gap-4">
        {errors.form ? <Banner tone="warning">{errors.form}</Banner> : null}
        <FormField label={t('currentPassword')} error={errors.current} required>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
            }}
          />
        </FormField>
        <FormField
          label={t('newPassword')}
          helper={ta('fields.passwordHelp')}
          error={errors.next}
          required
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
            }}
          />
        </FormField>
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          disabled={pending || !current || !next}
        >
          {t('changePassword')}
        </Button>
      </form>
    </Section>
  );
}

/** A QR code drawn from the otpauth URI in the browser: the secret never leaves the page. */
function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value]);
  const cells: string[] = [];
  data.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) cells.push(`M${String(x)} ${String(y)}h1v1h-1z`);
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className="size-44 rounded-sm bg-surface text-fg"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} className="fill-surface" />
      <path d={cells.join('')} fill="currentColor" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useTranslations('settings.security');
  const ta = useTranslations('auth.mfa');
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Banner tone="warning" title={ta('recoveryTitle')}>
        {ta('recoveryBody')}
      </Banner>
      <ol className="grid max-w-md grid-cols-2 gap-2 font-mono text-body">
        {codes.map((c) => (
          <li key={c} className="rounded-sm bg-subtle px-3 py-1.5 tabular-nums">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(codes.join('\n')).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? t('copied') : t('copyCodes')}
        </Button>
        <Button variant="primary" onClick={onDone}>
          {t('codesSaved')}
        </Button>
      </div>
    </div>
  );
}

type Proof = { code: string } | { recoveryCode: string };

/** Ask for a current code or a recovery code before a sensitive two-step change. */
function ProofDialog({
  title,
  action,
  danger,
  onSubmit,
  onClose,
}: {
  title: string;
  action: string;
  danger?: boolean;
  onSubmit: (proof: Proof) => Promise<ApiResult<unknown>>;
  onClose: () => void;
}) {
  const t = useTranslations('settings.security');
  const common = useTranslations('common');
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async () => {
    setPending(true);
    const result = await onSubmit(
      recovery ? { recoveryCode: value.trim() } : { code: value.replace(/\s/g, '') },
    );
    setPending(false);
    if (!result.ok) setError(t('invalidCode'));
  };
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description={t('proofBody')}
      closeLabel={common('actions.close')}
      footer={
        <>
          <Button onClick={onClose}>{common('actions.cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={pending || !value.trim()}
            onClick={() => void submit()}
          >
            {action}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={recovery ? t('recoveryCode') : t('code')} error={error ?? undefined}>
          <Input
            value={value}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </FormField>
        <Button
          variant="link"
          className="self-start"
          onClick={() => {
            setRecovery(!recovery);
            setValue('');
            setError(null);
          }}
        >
          {recovery ? t('useCode') : t('useRecovery')}
        </Button>
      </div>
    </Dialog>
  );
}

function MfaSection({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const t = useTranslations('settings.security');
  const ta = useTranslations('auth.mfa');
  const toast = useToast();
  const [enrolment, setEnrolment] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState<'disable' | 'codes' | null>(null);

  const start = async () => {
    const r = await cellApi<{ otpauthUri: string; secret: string }>(
      'POST',
      '/auth/mfa/totp/enroll',
      {},
    );
    if (r.ok) setEnrolment(r.data);
    else toast({ tone: 'error', title: ta('expired') });
  };
  const confirm = async () => {
    const r = await cellApi<{ recoveryCodes: string[] }>('POST', '/auth/mfa/totp/confirm', {
      code: code.replace(/\s/g, ''),
    });
    if (!r.ok) {
      setError(t('invalidCode'));
      return;
    }
    setEnrolment(null);
    setCode('');
    setCodes(r.data.recoveryCodes);
    onChange(true);
  };

  return (
    <Section title={t('mfaTitle')}>
      {codes ? (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
          }}
        />
      ) : enrolment ? (
        <div className="flex flex-col gap-4">
          <p className="text-body-sm text-fg-secondary">{ta('enrollBody')}</p>
          <QrCode value={enrolment.otpauthUri} label={ta('enrollTitle')} />
          <div>
            <p className="text-caption text-fg-secondary">{t('secretLabel')}</p>
            <code className="font-mono text-body-sm tracking-wider">{enrolment.secret}</code>
          </div>
          <div className="flex max-w-lg items-end gap-2">
            <FormField label={t('code')} error={error ?? undefined} className="flex-1">
              <Input
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                }}
              />
            </FormField>
            <Button variant="primary" disabled={!code.trim()} onClick={() => void confirm()}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <StatusChip tone={enabled ? 'success' : 'neutral'} dot>
              {enabled ? t('mfaOn') : t('mfaOff')}
            </StatusChip>
          </div>
          <div className="flex flex-wrap gap-2">
            {enabled ? (
              <>
                <Button
                  onClick={() => {
                    setAsking('codes');
                  }}
                >
                  {t('newCodes')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setAsking('disable');
                  }}
                >
                  {t('turnOff')}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void start()}>
                {t('turnOn')}
              </Button>
            )}
          </div>
        </div>
      )}
      {asking ? (
        <ProofDialog
          title={asking === 'disable' ? t('turnOff') : t('newCodes')}
          action={asking === 'disable' ? t('turnOff') : t('newCodes')}
          danger={asking === 'disable'}
          onClose={() => {
            setAsking(null);
          }}
          onSubmit={async (proof) => {
            if (asking === 'disable') {
              const r = await cellApi('POST', '/v1/me/mfa/disable', proof);
              if (r.ok) {
                setAsking(null);
                onChange(false);
                toast({ tone: 'success', title: t('mfaDisabled') });
              }
              return r;
            }
            const r = await cellApi<{ recoveryCodes: string[] }>(
              'POST',
              '/v1/me/mfa/recovery-codes',
              proof,
            );
            if (r.ok) {
              setAsking(null);
              setCodes(r.data.recoveryCodes);
            }
            return r;
          }}
        />
      ) : null}
    </Section>
  );
}

function SessionsSection() {
  const t = useTranslations('settings.security');
  const format = useFormatter();
  const toast = useToast();
  const { signOut } = useShell();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    void cellApi<{ items: Session[] }>('GET', '/v1/me/sessions').then((r) => {
      if (r.ok) setSessions(r.data.items);
    });
  }, [nonce]);
  const when = (iso: string) => format.relativeTime(new Date(iso));
  const end = async (id: string, current: boolean) => {
    if (current) {
      signOut();
      return;
    }
    const r = await cellApi('DELETE', `/v1/me/sessions/${id}`);
    if (r.ok) toast({ tone: 'success', title: t('signedOut') });
    setNonce((n) => n + 1);
  };
  const endOthers = async () => {
    const r = await cellApi<{ revoked: number }>('POST', '/v1/me/sessions/revoke-others');
    if (r.ok) toast({ tone: 'success', title: t('signedOutOthers', { count: r.data.revoked }) });
    setNonce((n) => n + 1);
  };
  return (
    <Section title={t('sessionsTitle')}>
      {sessions === null ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-body-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-fg">{s.userAgent ?? t('unknownDevice')}</p>
                  <p className="text-caption text-fg-secondary">
                    {s.ip ? `${s.ip} · ` : ''}
                    {t('lastActive', { when: when(s.lastSeenAt) })} ·{' '}
                    {t('signedInAt', { when: when(s.createdAt) })}
                  </p>
                </div>
                {s.current ? <StatusChip tone="info">{t('thisDevice')}</StatusChip> : null}
                {s.mfaVerified ? <StatusChip tone="success">{t('mfaVerified')}</StatusChip> : null}
                <Button size="sm" onClick={() => void end(s.id, s.current)}>
                  {t('signOut')}
                </Button>
              </li>
            ))}
          </ul>
          {sessions.length > 1 ? (
            <Button className="self-start" onClick={() => void endOthers()}>
              {t('signOutOthers')}
            </Button>
          ) : null}
        </>
      )}
    </Section>
  );
}
