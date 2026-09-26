import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ProfileSettings } from '../../../../components/settings/settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.sections');
  return { title: t('profile') };
}

export default function Page() {
  return <ProfileSettings />;
}
