import 'server-only';

import { headers } from 'next/headers';
import { cache } from 'react';

import { bffDeps } from './deps';
import { classifyHost } from './host';
import type { Tenant } from './tenant-directory';

export type RequestWorkspace =
  { kind: 'apex' } | { kind: 'workspace'; tenant: Tenant } | { kind: 'unknown' };

/**
 * The workspace this page request is for, resolved once per request. Directory outages propagate
 * (DirectoryUnavailableError) so the error boundary shows "briefly unavailable", not a 404.
 */
export const requestWorkspace = cache(async (): Promise<RequestWorkspace> => {
  const deps = bffDeps();
  const host = classifyHost((await headers()).get('host'), deps.baseDomain);
  if (host.kind === 'apex') return { kind: 'apex' };
  if (host.kind === 'invalid') return { kind: 'unknown' };
  const tenant = await deps.directory.resolve(host.host);
  return tenant ? { kind: 'workspace', tenant } : { kind: 'unknown' };
});
