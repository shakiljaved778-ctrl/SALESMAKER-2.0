import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SharingSettings } from '../../../../components/setup/sharing/sharing-settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.sharing');
  return { title: t('title') };
}

export default function Page() {
  return <SharingSettings />;
}
