import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ComingSoon } from '../../../components/shell/coming-soon';
import { PLACEHOLDER_SECTIONS, type NavKey } from '../../../components/shell/nav';

function sectionOf(value: string): NavKey | null {
  return PLACEHOLDER_SECTIONS.has(value as NavKey) ? (value as NavKey) : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const section = sectionOf((await params).section);
  if (!section) return {};
  const t = await getTranslations('shell.nav');
  return { title: t(section) };
}

/** Sidebar sections whose modules arrive in later phases (§12). */
export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const section = sectionOf((await params).section);
  if (!section) notFound();
  return <ComingSoon section={section} />;
}
