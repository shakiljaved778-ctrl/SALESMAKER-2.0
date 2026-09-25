import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AuthHeader } from '../../../components/auth/shared';
import { requireWorkspace } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.acceptInvite');
  return { title: t('title') };
}

/** Placeholder until invitations ship in P01; the route exists so invite links never 404. */
export default async function AcceptInvitePage() {
  await requireWorkspace();
  const t = await getTranslations('auth.acceptInvite');
  return <AuthHeader title={t('title')} subtitle={t('comingSoon')} />;
}
