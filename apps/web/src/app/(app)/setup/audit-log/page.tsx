import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AuditLogViewer } from '../../../../components/setup/viewers/viewers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.auditLog');
  return { title: t('title') };
}

export default function Page() {
  return <AuditLogViewer />;
}
