import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { HomeView } from '../../../components/shell/home-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.nav');
  return { title: t('home') };
}

export default function HomePage() {
  return <HomeView />;
}
