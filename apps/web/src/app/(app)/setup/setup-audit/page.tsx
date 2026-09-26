import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SetupAuditViewer } from '../../../../components/setup/viewers/viewers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.setupAudit');
  return { title: t('title') };
}

export default function Page() {
  return <SetupAuditViewer />;
}
