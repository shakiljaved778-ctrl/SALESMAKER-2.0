import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { DisplaySettings } from '../../../../components/settings/settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.sections');
  return { title: t('display') };
}

export default function Page() {
  return <DisplaySettings />;
}
