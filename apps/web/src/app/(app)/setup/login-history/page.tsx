import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { LoginHistoryViewer } from '../../../../components/setup/viewers/viewers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.loginHistory');
  return { title: t('title') };
}

export default function Page() {
  return <LoginHistoryViewer />;
}
