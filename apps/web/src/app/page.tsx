import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { bffDeps } from '../server/deps';
import { requestWorkspace } from '../server/request-tenant';
import { refreshCookieName } from '../server/session-cookie';

export const dynamic = 'force-dynamic';

/** Entry per host: the apex starts sign-up; a workspace goes home when a session cookie exists. */
export default async function Root() {
  const workspace = await requestWorkspace();
  if (workspace.kind === 'unknown') notFound();
  if (workspace.kind === 'apex') redirect('/sign-up');
  const hasSession = (await cookies()).has(refreshCookieName(bffDeps().scheme));
  redirect(hasSession ? '/home' : '/sign-in');
}
