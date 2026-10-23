import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SystemPage } from '../../../components/system-page';
import { webEnvProblems } from '../../../server/env';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('system.notConfigured');
  return { title: t('title') };
}

/**
 * Every page while the deployment lacks required settings (proxy.ts rewrites here with a 503).
 * Names the variables, never their values, and calls nothing that needs them.
 */
export default async function NotConfigured() {
  const t = await getTranslations('system.notConfigured');
  const missing = webEnvProblems();
  return (
    <SystemPage
      code="503"
      title={t('title')}
      body={missing.length > 0 ? t('body', { variables: missing.join(', ') }) : t('configured')}
    />
  );
}
