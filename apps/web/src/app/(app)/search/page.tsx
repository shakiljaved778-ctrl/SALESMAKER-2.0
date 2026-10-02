import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SearchResults } from '../../../components/records/search-results';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('records.search');
  return { title: t('title') };
}

/** Global search results (§7.19). */
export default function SearchPage() {
  return <SearchResults />;
}
