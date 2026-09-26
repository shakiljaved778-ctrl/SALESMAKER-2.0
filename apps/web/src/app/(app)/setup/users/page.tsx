import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { UsersList } from '../../../../components/setup/users/users-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup.users');
  return { title: t('title') };
}

export default function UsersPage() {
  return <UsersList />;
}
