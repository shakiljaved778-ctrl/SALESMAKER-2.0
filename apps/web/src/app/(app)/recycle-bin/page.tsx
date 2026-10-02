import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { RecycleBin } from '../../../components/records/recycle-bin';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('records.recycleBin');
  return { title: t('title') };
}

export default function RecycleBinPage() {
  return <RecycleBin />;
}
