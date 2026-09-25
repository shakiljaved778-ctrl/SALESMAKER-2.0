import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ResetPasswordForm } from '../../../components/auth/token-pages';
import { requireWorkspace } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.resetPassword');
  return { title: t('title'), referrer: 'no-referrer' };
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireWorkspace();
  const { token } = await searchParams;
  return <ResetPasswordForm token={typeof token === 'string' ? token : null} />;
}
