import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { DuplicateReview } from '../../../../components/duplicates/duplicate-review';
import { DEDUPE_OBJECTS } from '../../../../components/duplicates/objects';
import { objectForSection } from '../../../../components/records/fields';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('duplicates.review');
  return { title: t('pageTitle') };
}

/** Duplicate review (§7.2, T7) for leads, contacts and accounts. */
export default async function DuplicatesRoute({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const object = objectForSection(section);
  if (!object || !DEDUPE_OBJECTS.has(object)) notFound();
  return <DuplicateReview object={object} section={section} />;
}
