import type { Metadata } from 'next';

import { getTranslations } from 'next-intl/server';

import { OrgHierarchy } from '../../../../components/setup/org-units/org-hierarchy';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.orgUnits');
  return { title: t('title') };
}

export default function Page() {
  return <OrgHierarchy />;
}
