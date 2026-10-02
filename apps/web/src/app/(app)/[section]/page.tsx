import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { objectForSection } from '../../../components/records/fields';
import { ObjectList } from '../../../components/records/object-list';
import { ComingSoon } from '../../../components/shell/coming-soon';
import { PLACEHOLDER_SECTIONS, type NavKey } from '../../../components/shell/nav';

const PLURAL = {
  lead: 'lead.plural',
  account: 'account.plural',
  contact: 'contact.plural',
  opportunity: 'opportunity.plural',
  campaign: 'campaign.plural',
} as const;

function sectionOf(value: string): NavKey | null {
  return PLACEHOLDER_SECTIONS.has(value as NavKey) ? (value as NavKey) : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const raw = (await params).section;
  const object = objectForSection(raw);
  if (object) {
    const t = await getTranslations('objects');
    return { title: t(PLURAL[object]) };
  }
  const section = sectionOf(raw);
  if (!section) return {};
  const t = await getTranslations('shell.nav');
  return { title: t(section) };
}

/** Object homes (§9.11 T1); other sidebar sections arrive in later phases (§12). */
export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const raw = (await params).section;
  const object = objectForSection(raw);
  if (object) return <ObjectList key={object} object={object} section={raw} />;
  const section = sectionOf(raw);
  if (!section) notFound();
  return <ComingSoon section={section} />;
}
