import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell } from '../../components/shell/app-shell';
import { PREFERENCE_COOKIES } from '../../lib/preferences';
import { bffDeps } from '../../server/deps';
import { requireWorkspace } from '../../server/guards';
import { refreshCookieName } from '../../server/session-cookie';

/** Signed-in pages: without a session cookie there is nothing to restore, so go to sign-in. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireWorkspace();
  const store = await cookies();
  if (!store.has(refreshCookieName(bffDeps().scheme))) redirect('/sign-in');
  return (
    <AppShell
      workspace={tenant.name}
      initialCollapsed={store.get(PREFERENCE_COOKIES.sidebar)?.value === 'collapsed'}
    >
      {children}
    </AppShell>
  );
}
