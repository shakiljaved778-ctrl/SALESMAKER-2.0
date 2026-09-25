import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { bffDeps } from './deps';
import { requestWorkspace } from './request-tenant';
import type { Tenant } from './tenant-directory';

/** Pages that belong to a workspace: the apex sends people to "find your workspace". */
export async function requireWorkspace(): Promise<Tenant> {
  const workspace = await requestWorkspace();
  if (workspace.kind === 'apex') redirect('/find-workspace');
  if (workspace.kind === 'unknown') notFound();
  return workspace.tenant;
}

/** Pages that live on the apex (sign-up, find): a workspace host forwards to the apex. */
export async function requireApex(path: string): Promise<{ baseDomain: string; scheme: string }> {
  const workspace = await requestWorkspace();
  const { baseDomain, scheme } = bffDeps();
  if (workspace.kind !== 'apex') redirect(`${scheme}://${baseDomain}${path}`);
  return { baseDomain, scheme };
}
