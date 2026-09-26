'use client';

import { useTranslations } from 'next-intl';

import type { ApiResult } from '../../lib/client-api';

/**
 * A failed Setup call as one translated sentence. `specific` maps problem codes (or `conflict`)
 * to the page's own wording for refusals only it understands.
 */
export function useSetupProblem() {
  const t = useTranslations('setup.common');
  return (result: ApiResult<unknown>, specific: Record<string, string> = {}): string => {
    if (result.ok) return '';
    const code = result.problem?.code;
    if (code && specific[code]) return specific[code];
    if (code === 'version_conflict') return t('staleVersion');
    if (result.status === 403) return t('notAllowed');
    if (result.status === 404) return t('notFound');
    if (result.status === 400 || result.status === 422) return t('invalid');
    return t('unavailable');
  };
}
