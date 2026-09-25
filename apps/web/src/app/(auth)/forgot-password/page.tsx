import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ForgotPasswordForm } from '../../../components/auth/email-forms';
import { requireWorkspace } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgotPassword');
  return { title: t('title') };
}

export default async function ForgotPasswordPage() {
  await requireWorkspace();
  return <ForgotPasswordForm />;
}
