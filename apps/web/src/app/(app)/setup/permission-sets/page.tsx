import type { Metadata } from 'next';

import { getTranslations } from 'next-intl/server';

import { PermissionSetsList } from '../../../../components/setup/permissions/lists';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.permissionSets');
  return { title: t('title') };
}

export default function Page() {
  return <PermissionSetsList />;
}
