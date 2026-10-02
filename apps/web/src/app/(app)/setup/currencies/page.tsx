import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CurrenciesPage } from '../../../../components/setup/currencies/currencies-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.currencies');
  return { title: t('title') };
}

export default function SetupCurrenciesPage() {
  return <CurrenciesPage />;
}
