import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { GrantsDetail } from '../../../../../components/setup/permissions/grants-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.permissionSets');
  return { title: t('title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <GrantsDetail kind="permission-sets" id={id} />;
}
