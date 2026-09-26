import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { QueuesList } from '../../../../components/setup/groups/groups-pages';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.queues');
  return { title: t('title') };
}

export default function Page() {
  return <QueuesList />;
}
