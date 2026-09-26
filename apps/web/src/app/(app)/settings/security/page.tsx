import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SecuritySettings } from '../../../../components/settings/settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.sections');
  return { title: t('security') };
}

export default function Page() {
  return <SecuritySettings />;
}
