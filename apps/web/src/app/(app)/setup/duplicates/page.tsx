import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { DuplicatesSetup } from '../../../../components/setup/duplicates/duplicates-setup';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.duplicates');
  return { title: t('title') };
}

export default function DuplicatesSetupPage() {
  return <DuplicatesSetup />;
}
