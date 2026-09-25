'use client';

import { Banner, Button } from '@sm/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { ApiResult } from '../../lib/client-api';

export function AuthHeader({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-1.5">
      <h1 className="text-title-1 text-fg">{title}</h1>
      {subtitle ? <p className="text-body text-fg-secondary">{subtitle}</p> : null}
    </header>
  );
}

/** Form-level error, announced assertively by the danger Banner. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Banner tone="danger" className="mb-4">
      {message}
    </Banner>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-caption text-fg-secondary">
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      {label}
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}

export function ProviderButtons({
  onChoose,
  disabled,
}: {
  onChoose: (provider: 'google' | 'microsoft') => void;
  disabled?: boolean;
}) {
  const t = useTranslations('auth.signIn');
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          onChoose('google');
        }}
      >
        {t('google')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          onChoose('microsoft');
        }}
      >
        {t('microsoft')}
      </Button>
    </div>
  );
}

/**
 * The message for a failed BFF call that no field claimed: lockout (with minutes), rate limit,
 * outage, or the fallback the caller names.
 */
export function useProblemMessage() {
  const t = useTranslations('auth.errors');
  return (result: ApiResult<unknown>, fallback: string): string => {
    if (result.ok) return fallback;
    if (result.status === 423) {
      return t('locked', { minutes: Math.max(1, Math.ceil((result.retryAfter ?? 60) / 60)) });
    }
    if (result.status === 429) return t('rateLimited');
    if (result.status === 0 || result.status >= 500) return t('unavailable');
    return fallback;
  };
}
