import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ImportWizard } from '../../../../components/imports/import-wizard';
import { IMPORTABLE } from '../../../../components/imports/types';
import { objectForSection } from '../../../../components/records/fields';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('imports');
  return { title: t('pageTitle') };
}

/** The import wizard (§7.1, T6) for leads, accounts and contacts; `?job=` resumes one. */
export default async function ImportRoute({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const object = objectForSection(section);
  if (!object || !IMPORTABLE.has(object)) notFound();
  return <ImportWizard object={object} section={section} />;
}
