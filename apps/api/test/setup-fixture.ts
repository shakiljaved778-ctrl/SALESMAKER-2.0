import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { expect } from 'vitest';

import { provisionDefaultProfiles } from '../src/permissions/default-profiles.js';
import { provisionOrgWideDefaults } from '../src/sharing/sharing.service.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

const PASSWORD = 'a sturdy passphrase 4821';
type Json = Record<string, unknown>;
export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Two workspaces for the Setup API tests. In A: `admin` (System Administrator), `viewer`
 * (Standard User + a set granting view_setup only) and `rep` / `peer` (Standard Users). In B:
 * `outsider` (System Administrator), who must never reach A's Setup entities (404).
 */
export interface SetupFixture {
  api: TestApi;
  prisma: CellPrisma;
  tenantId: string;
  otherTenant: string;
  id: (name: string) => string;
  set: (name: string, value: string) => void;
  call: (
    user: string,
    method: Method,
    url: string,
    payload?: Json,
  ) => ReturnType<TestApi['app']['inject']>;
  inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
  /** The four checks every Setup endpoint gets besides its happy path. */
  expectGuarded: (
    method: Method,
    url: string,
    options: { payload?: Json; reader?: boolean },
  ) => Promise<void>;
}

export async function setupFixture(
  slug: string,
  deps: Parameters<typeof startTestApi>[1] = {},
): Promise<SetupFixture> {
  const api = await startTestApi({}, deps);
  const prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  const ids = new Map<string, string>();
  const id = (name: string) => {
    const v = ids.get(name);
    if (!v) throw new Error(`no fixture ${name}`);
    return v;
  };
  const tenantId = await api.seedTenant(slug);
  const otherTenant = await api.seedTenant(`${slug}-other`);
  for (const name of ['admin', 'viewer', 'rep', 'peer'])
    ids.set(name, await api.seedUser(tenantId, `${name}@${slug}.test`, PASSWORD));
  ids.set('outsider', await api.seedUser(otherTenant, `outsider@${slug}.test`, PASSWORD));

  for (const tenant of [tenantId, otherTenant])
    await withTenant(prisma, { tenantId: tenant }, async (tx) => {
      const profiles = await provisionDefaultProfiles(tx, tenant, 'en');
      await provisionOrgWideDefaults(tx);
      const place = (user: string, profileId: string) =>
        tx.prisma.user.update({
          where: { tenantId_id: { tenantId: tenant, id: id(user) } },
          data: { profileId },
        });
      if (tenant === otherTenant) {
        await place('outsider', profiles.system_administrator);
        return;
      }
      ids.set('profile:admin', profiles.system_administrator);
      ids.set('profile:standard', profiles.standard_user);
      ids.set('profile:readonly', profiles.read_only);
      await place('admin', profiles.system_administrator);
      for (const u of ['viewer', 'rep', 'peer']) await place(u, profiles.standard_user);
      const viewSetup = await tx.prisma.permissionSet.create({
        data: { tenantId, name: 'Setup viewer' },
      });
      await tx.prisma.systemPermission.create({
        data: { tenantId, permissionSetId: viewSetup.id, name: 'view_setup' },
      });
      await tx.prisma.permissionAssignment.create({
        data: { tenantId, userId: id('viewer'), permissionSetId: viewSetup.id },
      });
      ids.set('set:viewSetup', viewSetup.id);
    });

  const call: SetupFixture['call'] = async (user, method, url, payload) => {
    const tenant = user === 'outsider' ? otherTenant : tenantId;
    return api.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await api.tokenFor(tenant, id(user))}` },
      ...(payload ? { payload } : {}),
    });
  };

  return {
    api,
    prisma,
    tenantId,
    otherTenant,
    id,
    set: (name, value) => ids.set(name, value),
    call,
    inTenant: (fn) => withTenant(prisma, { tenantId }, fn),
    async expectGuarded(method, url, { payload, reader = method === 'GET' }) {
      // Permission denial: a Standard User holds neither view_setup nor the change permission.
      expect((await call('rep', method, url, payload)).statusCode, `rep ${method} ${url}`).toBe(
        403,
      );
      // view_setup reads but never changes.
      expect((await call('viewer', method, url, payload)).statusCode, `viewer ${method}`).toBe(
        reader ? 200 : 403,
      );
      // Another workspace's administrator sees nothing of it.
      if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(url))
        expect((await call('outsider', method, url, payload)).statusCode, `outsider ${url}`).toBe(
          404,
        );
      // Validation: a malformed id is refused before anything runs.
      const malformed = url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, 'not-a-uuid');
      if (malformed !== url)
        expect((await call('admin', method, malformed, payload)).statusCode, malformed).toBe(400);
    },
  };
}
