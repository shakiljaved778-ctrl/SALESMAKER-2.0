import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ObjectsPage } from '../../../../components/setup/objects/objects-pages';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.objects');
  return { title: t('title') };
}

export default function ObjectManagerPage() {
  return <ObjectsPage />;
}
