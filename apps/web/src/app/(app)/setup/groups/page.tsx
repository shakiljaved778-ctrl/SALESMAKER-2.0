import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { GroupsList } from '../../../../components/setup/groups/groups-pages';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.publicGroups');
  return { title: t('title') };
}

export default function Page() {
  return <GroupsList />;
}
