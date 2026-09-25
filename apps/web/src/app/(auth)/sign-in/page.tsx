import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SignInForm } from '../../../components/auth/sign-in-form';
import { bffDeps } from '../../../server/deps';
import { requireWorkspace } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn');
  return { title: t('submit') };
}

export default async function SignInPage() {
  const tenant = await requireWorkspace();
  const { scheme, baseDomain } = bffDeps();
  const apex = `${scheme}://${baseDomain}`;
  return (
    <SignInForm
      workspace={tenant.name}
      signUpUrl={`${apex}/sign-up`}
      findWorkspaceUrl={`${apex}/find-workspace`}
    />
  );
}
