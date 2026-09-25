import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { HomeSession } from '../../components/home-session';
import { requireWorkspace } from '../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.nav');
  return { title: t('home') };
}

export default async function HomePage() {
  await requireWorkspace();
  return (
    <main className="mx-auto w-full max-w-3xl p-[var(--page-padding)]">
      <HomeSession />
    </main>
  );
}
