import { EmptyState } from '@sm/ui';
import { Construction } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import type { NavKey } from './nav';

export async function ComingSoon({ section }: { section: NavKey }) {
  const t = await getTranslations('shell');
  const name = t(`nav.${section}`);
  return (
    <div className="p-[var(--page-padding)]">
      <h1 className="sr-only">{name}</h1>
      <EmptyState
        icon={<Construction />}
        title={t('comingSoonTitle', { section: name })}
        description={t('comingSoon')}
        className="mt-16"
      />
    </div>
  );
}
