import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { bffDeps } from './deps';
import { classifyHost } from './host';
import { DirectoryUnavailableError, type Tenant } from './tenant-directory';

export type RequestWorkspace =
  { kind: 'apex' } | { kind: 'workspace'; tenant: Tenant } | { kind: 'unknown' };

/**
 * The workspace this page request is for, resolved once per request. A directory outage goes to
 * the maintenance page, never to a 404 (the workspace may well exist).
 */
export const requestWorkspace = cache(async (): Promise<RequestWorkspace> => {
  const deps = bffDeps();
  const host = classifyHost((await headers()).get('host'), deps.baseDomain);
  if (host.kind === 'apex') return { kind: 'apex' };
  if (host.kind === 'invalid') return { kind: 'unknown' };
  let tenant: Tenant | null;
  try {
    tenant = await deps.directory.resolve(host.host);
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) redirect('/maintenance');
    throw err;
  }
  return tenant ? { kind: 'workspace', tenant } : { kind: 'unknown' };
});
