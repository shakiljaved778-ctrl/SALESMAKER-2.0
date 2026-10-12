import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ImportHistory } from '../../../../../components/imports/import-history';
import { IMPORTABLE } from '../../../../../components/imports/types';
import { objectForSection } from '../../../../../components/records/fields';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('imports.history');
  return { title: t('title') };
}

/** The caller's imports of one object, newest first. */
export default async function ImportHistoryRoute({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const object = objectForSection(section);
  if (!object || !IMPORTABLE.has(object)) notFound();
  const t = await getTranslations('imports.history');
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-[var(--page-padding)]">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-title-1 text-fg">{t('title')}</h1>
        <Link href={`/${section}/import`} className="text-body-sm text-link">
          {t('newImport')}
        </Link>
      </div>
      <ImportHistory object={object} />
    </div>
  );
}
