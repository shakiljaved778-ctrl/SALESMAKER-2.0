import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ImportHistory } from '../../../../components/imports/import-history';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.dataImport');
  return { title: t('title') };
}

/** Setup → Data import history (§9.15): every import in the workspace. */
export default async function DataImportPage() {
  const t = await getTranslations('setup.dataImport');
  return (
    <div className="flex flex-col gap-4 p-[var(--page-padding)]">
      <div>
        <h1 className="text-title-1 text-fg">{t('title')}</h1>
        <p className="text-body-sm text-fg-secondary">{t('description')}</p>
      </div>
      <ImportHistory all />
    </div>
  );
}
