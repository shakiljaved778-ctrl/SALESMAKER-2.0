import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { FindWorkspaceForm } from '../../../components/auth/email-forms';
import { requireApex } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.findWorkspace');
  return { title: t('title') };
}

export default async function FindWorkspacePage() {
  await requireApex('/find-workspace');
  return <FindWorkspaceForm signUpUrl="/sign-up" />;
}
