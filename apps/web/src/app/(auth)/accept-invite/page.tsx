import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AcceptInviteForm } from '../../../components/auth/accept-invite-form';
import { requireWorkspace } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await requireWorkspace();
  const t = await getTranslations('auth.acceptInvite');
  return { title: t('title', { workspace: tenant.name }), referrer: 'no-referrer' };
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await requireWorkspace();
  const { token } = await searchParams;
  return (
    <AcceptInviteForm token={typeof token === 'string' ? token : null} workspace={tenant.name} />
  );
}
