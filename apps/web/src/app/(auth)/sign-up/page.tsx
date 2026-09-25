import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SignUpForm } from '../../../components/auth/sign-up-form';
import { bffDeps } from '../../../server/deps';
import { requireApex } from '../../../server/guards';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signUp');
  return { title: t('title') };
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { baseDomain } = await requireApex('/sign-up');
  const cells = (await bffDeps().controlPlane.listCells()) ?? [];
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
  return (
    <SignUpForm
      regions={cells.filter((c) => c.signupOpen).map((c) => ({ id: c.id, label: c.label }))}
      baseDomain={baseDomain}
      findWorkspaceUrl="/find-workspace"
      initialError={one(params.error)}
      initialProvider={one(params.provider)}
    />
  );
}
