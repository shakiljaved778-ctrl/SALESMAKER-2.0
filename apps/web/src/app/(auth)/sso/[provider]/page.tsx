import { notFound } from 'next/navigation';

import { SsoRedirect } from '../../../../components/auth/sso-redirect';
import { requireWorkspace } from '../../../../server/guards';
import { isProvider } from '../../../../server/oidc';

export const dynamic = 'force-dynamic';

export default async function SsoPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireWorkspace();
  const { provider } = await params;
  if (!isProvider(provider)) notFound();
  const { failed } = await searchParams;
  return <SsoRedirect provider={provider} failed={typeof failed === 'string' ? failed : null} />;
}
