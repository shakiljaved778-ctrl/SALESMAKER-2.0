import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { CATALOGUE_VERSION } from '@sm/metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MetadataService } from '../src/metadata/metadata.service.js';
import { provisionDefaultProfiles } from '../src/permissions/default-profiles.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let service: MetadataService;
let tenantId = '';
const users: Record<'admin' | 'rep' | 'viewer', string> = { admin: '', rep: '', viewer: '' };
const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  service = api.app.get(MetadataService);
  tenantId = await api.seedTenant('meta-service');
  const profiles = await inTenant((tx) => provisionDefaultProfiles(tx, tenantId, 'en'));
  const profileOf = {
    admin: 'system_administrator',
    rep: 'standard_user',
    viewer: 'read_only',
  } as const;
  for (const key of Object.keys(users) as (keyof typeof users)[]) {
    const id = await api.seedUser(tenantId, `${key}@meta.test`, 'a sturdy passphrase 4821');
    await inTenant((tx) =>
      tx.prisma.user.update({
        where: { tenantId_id: { tenantId, id } },
        data: { profileId: profiles[profileOf[key]] },
      }),
    );
    users[key] = id;
  }
});

afterAll(async () => {
  await api.dispose();
});

const describeFor = (user: keyof typeof users, object: string) =>
  inTenant(async (tx) => {
    const metadata = await service.forTenant(tx);
    const permissions = await api.app.get(PermissionService).forUser(tx, users[user]);
    return service.describe(metadata, object, permissions, 'en');
  });

describe('MetadataService.forTenant', () => {
  it('syncs a tenant that is behind the catalogue, then serves it from cache', async () => {
    const first = await inTenant((tx) => service.forTenant(tx));
    expect(first.object('lead')).toBeDefined();
    const settings = await inTenant((tx) =>
      tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
    expect(settings.catalogueVersion).toBe(CATALOGUE_VERSION);
    expect(first.version).toBe(settings.metadataVersion);
    // Same version: the same cached index.
    expect(await inTenant((tx) => service.forTenant(tx))).toBe(first);
  });

  it('reloads after any metadata change', async () => {
    const before = await inTenant((tx) => service.forTenant(tx));
    await inTenant((tx) =>
      tx.prisma.fieldDefinition.updateMany({
        where: { apiName: 'company', object: { apiName: 'lead' } },
        data: { label: 'Organisation' },
      }),
    );
    const after = await inTenant((tx) => service.forTenant(tx));
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.field('lead', 'company')?.label).toBe('Organisation');
    expect(before.field('lead', 'company')?.label).toBeNull();
  });
});

describe('MetadataService.describe', () => {
  it('shows an administrator every field with labels in their language', async () => {
    const lead = await describeFor('admin', 'lead');
    expect(lead).toMatchObject({
      name: 'lead',
      label: 'Lead',
      labelPlural: 'Leads',
      nameFields: ['first_name', 'last_name'],
      access: { read: true, create: true, edit: true, delete: true },
      recordTypes: [{ apiName: 'master', name: 'Master', default: true }],
    });
    const byName = new Map(lead?.fields.map((f) => [f.name, f]));
    expect(byName.get('company')?.label).toBe('Organisation'); // the admin rename above
    expect(byName.get('email')).toMatchObject({ label: 'Email', editable: true, sortable: true });
    expect(byName.get('created_at')).toMatchObject({ editable: false });
    expect(byName.get('record_number')).toMatchObject({ editable: false });
    expect(byName.get('description')).toMatchObject({ sortable: false });
    expect(byName.get('status')?.picklistValues?.slice(0, 2)).toEqual([
      { value: 'open', label: 'New', category: 'OPEN', default: true },
      { value: 'working', label: 'Working', category: 'WORKING', default: false },
    ]);
  });

  it('shows a read-only user nothing editable and a rep what their profile grants', async () => {
    const viewer = await describeFor('viewer', 'lead');
    expect(viewer?.access).toEqual({ read: true, create: false, edit: false, delete: false });
    expect(viewer?.fields.every((f) => !f.editable)).toBe(true);
    const rep = await describeFor('rep', 'opportunity');
    expect(rep?.access).toMatchObject({ read: true, edit: true });
    expect(rep?.fields.find((f) => f.name === 'amount')?.editable).toBe(true);
  });

  it('leaves out fields FLS hides, and hides custom fields until granted', async () => {
    await inTenant(async (tx) => {
      const lead = await tx.prisma.objectDefinition.findFirstOrThrow({
        where: { apiName: 'lead' },
      });
      await tx.prisma.fieldDefinition.createMany({
        data: [
          { tenantId, objectId: lead.id, apiName: 'region__c', type: 'text', required: true },
          { tenantId, objectId: lead.id, apiName: 'notes__c', type: 'text' },
        ],
      });
    });
    const rep = await describeFor('rep', 'lead');
    const names = rep?.fields.map((f) => f.name) ?? [];
    expect(names).toContain('region__c'); // required custom fields are always visible
    expect(names).not.toContain('notes__c');
    expect(rep?.fields.find((f) => f.name === 'region__c')).toMatchObject({
      custom: true,
      editable: true,
    });
  });

  it('answers null for unknown objects and objects the user cannot read', async () => {
    expect(await describeFor('admin', 'no_such_object')).toBeNull();
    await inTenant(async (tx) => {
      const rep = await tx.prisma.user.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: users.rep } },
        include: { profile: true },
      });
      await tx.prisma.objectPermission.updateMany({
        where: { permissionSetId: rep.profile?.permissionSetId ?? '', object: 'campaign' },
        data: {
          canRead: false,
          canCreate: false,
          canEdit: false,
          canDelete: false,
          viewAll: false,
          modifyAll: false,
        },
      });
    });
    expect(await describeFor('rep', 'campaign')).toBeNull();
  });
});
