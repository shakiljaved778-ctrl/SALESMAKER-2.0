import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionOrgWideDefaults, SharingService } from '../src/sharing/sharing.service.js';
import { PRISMA, REDIS } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let sharing: SharingService;
let tenantId = '';
let otherTenant = '';
let userId = '';

const inTenant = <T>(id: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId: id }, fn);

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  sharing = api.app.get(SharingService);
  tenantId = await api.seedTenant('sharing');
  otherTenant = await api.seedTenant('sharing-other');
  userId = await api.seedUser(tenantId, 'rep@sharing.test', 'a sturdy passphrase 4821');
  await inTenant(tenantId, (tx) => provisionOrgWideDefaults(tx));
});

afterAll(async () => {
  await api.dispose();
});

describe('SharingService.orgWideDefault (§6.3)', () => {
  it('reads the tenant’s setting, provisioned from the catalogue', async () => {
    await inTenant(tenantId, async (tx) => {
      expect(await sharing.orgWideDefault(tx, 'contact')).toEqual({
        sharingModel: 'CONTROLLED_BY_PARENT',
        grantHierarchy: true,
      });
      await tx.prisma.orgWideDefault.update({
        where: { tenantId_object: { tenantId, object: 'lead' } },
        data: { sharingModel: 'PUBLIC_READ' },
      });
      expect((await sharing.orgWideDefault(tx, 'lead')).sharingModel).toBe('PUBLIC_READ');
    });
  });

  it('falls back to the catalogue, and to PRIVATE for custom objects', async () => {
    await inTenant(otherTenant, async (tx) => {
      expect((await sharing.orgWideDefault(tx, 'campaign')).sharingModel).toBe('PUBLIC_READ');
      expect(await sharing.orgWideDefault(tx, 'project__c')).toEqual({
        sharingModel: 'PRIVATE',
        grantHierarchy: true,
      });
    });
  });

  it('provisions idempotently', async () => {
    await inTenant(tenantId, async (tx) => {
      await provisionOrgWideDefaults(tx);
      expect(await tx.prisma.orgWideDefault.count()).toBe(10);
    });
  });
});

describe('SharingService.principals (§6.4)', () => {
  it('caches the principal set under permVersion and sees a membership change at once', async () => {
    const first = await inTenant(tenantId, (tx) => sharing.principals(tx, userId));
    expect(first).toMatchObject({ userId, groupIds: [], queueIds: [] });
    const version = await inTenant(
      tenantId,
      async (tx) =>
        (await tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId } })).permVersion,
    );
    const redis = api.app.get<symbol, Redis>(REDIS);
    expect(await redis.exists(`principals:${tenantId}:${userId}:${String(version)}`)).toBe(1);

    const groupId = await inTenant(tenantId, async ({ prisma: tx }) => {
      const g = await tx.publicGroup.create({ data: { tenantId, name: 'Closers' } });
      await tx.groupMember.create({
        data: { tenantId, groupId: g.id, memberType: 'USER', userId },
      });
      return g.id;
    });
    const after = await inTenant(tenantId, (tx) => sharing.principals(tx, userId));
    expect(after.groupIds).toEqual([groupId]);
  });
});
