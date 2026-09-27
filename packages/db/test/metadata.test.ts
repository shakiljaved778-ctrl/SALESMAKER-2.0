import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { loadTenantMetadata } from '../src/metadata.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-0000000000e1';
const OTHER = '01920000-0000-7000-8000-0000000000e2';

let db: TestCellDatabase;
let prisma: CellPrisma;
const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);
const load = (tenantId: string) => inTenant(tenantId, (tx) => loadTenantMetadata(tx, 7));

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  for (const tenantId of [TENANT, OTHER])
    await inTenant(tenantId, ({ prisma: p }) =>
      p.tenantSettings.create({
        data: {
          tenantId,
          name: tenantId,
          slug: tenantId.slice(-4),
          region: 'eu-central-1',
          corporateCurrency: 'USD',
          defaultTimezone: 'UTC',
        },
      }),
    );

  await inTenant(TENANT, async ({ prisma: p }) => {
    const t = { tenantId: TENANT };
    const lead = await p.objectDefinition.create({
      data: {
        ...t,
        apiName: 'lead',
        isStandard: true,
        icon: 'user-round-plus',
        color: 'cobalt',
        recordNumberPrefix: 'L',
        nameField: 'last_name',
        features: { history: true },
      },
    });
    await p.objectDefinition.create({
      data: {
        ...t,
        apiName: 'gone',
        icon: 'x',
        color: 'graphite',
        recordNumberPrefix: 'G',
        nameField: 'name',
        deletedAt: new Date(),
      },
    });
    const field = (apiName: string, type: 'text' | 'picklist' | 'auto_number', extra = {}) =>
      p.fieldDefinition.create({
        data: {
          ...t,
          objectId: lead.id,
          apiName,
          isStandard: !apiName.endsWith('__c'),
          type,
          ...extra,
        },
      });
    await field('last_name', 'text', { required: true, sortOrder: 1 });
    const status = await field('status', 'picklist', { sortOrder: 2 });
    const tier = await field('tier__c', 'picklist', {
      label: 'Tier',
      sortOrder: 3,
      trackHistory: true,
    });
    await field('old__c', 'text', { deletedAt: new Date() });
    const recordNumber = await field('record_number', 'auto_number', {
      system: true,
      sortOrder: 0,
    });
    await p.autoNumberSequence.create({
      data: { ...t, fieldId: recordNumber.id, format: 'L-{000000}' },
    });

    const open = await p.picklistValue.create({
      data: {
        ...t,
        fieldId: status.id,
        apiValue: 'open',
        category: 'OPEN',
        isDefault: true,
        sortOrder: 0,
      },
    });
    await p.picklistValue.create({
      data: {
        ...t,
        fieldId: status.id,
        apiValue: 'working',
        category: 'WORKING',
        label: 'In play',
        sortOrder: 1,
      },
    });
    const gold = await p.picklistValue.create({
      data: { ...t, fieldId: tier.id, apiValue: 'gold' },
    });
    await p.picklistValue.create({
      data: { ...t, fieldId: tier.id, apiValue: 'silver', active: false },
    });

    const master = await p.recordType.create({
      data: { ...t, objectId: lead.id, apiName: 'master', name: 'Master', isDefault: true },
    });
    const vip = await p.recordType.create({
      data: { ...t, objectId: lead.id, apiName: 'vip', name: 'VIP' },
    });
    await p.recordTypePicklist.createMany({
      data: [
        { ...t, recordTypeId: vip.id, picklistValueId: gold.id, isDefault: true },
        { ...t, recordTypeId: vip.id, picklistValueId: open.id },
      ],
    });
    const layout = await p.pageLayout.create({
      data: {
        ...t,
        objectId: lead.id,
        name: 'Lead layout',
        isDefault: true,
        sections: [{ key: 'details' }],
      },
    });
    const vipLayout = await p.pageLayout.create({
      data: { ...t, objectId: lead.id, name: 'VIP layout' },
    });
    const set = await p.permissionSet.create({ data: { ...t, kind: 'PROFILE', name: 'Rep' } });
    const profile = await p.profile.create({
      data: { ...t, name: 'Rep', permissionSetId: set.id },
    });
    await p.layoutAssignment.create({
      data: {
        ...t,
        objectId: lead.id,
        profileId: profile.id,
        recordTypeId: vip.id,
        pageLayoutId: vipLayout.id,
      },
    });
    expect(layout.isDefault).toBe(true);
    await p.compactLayout.create({
      data: {
        ...t,
        objectId: lead.id,
        name: 'Highlights',
        isDefault: true,
        fields: ['last_name', 'status'],
      },
    });
    await p.validationRule.create({
      data: {
        ...t,
        objectId: lead.id,
        apiName: 'needs_name',
        formula: 'ISBLANK(last_name)',
        errorMessage: 'Name it',
        errorField: 'last_name',
      },
    });
    await p.pathSetting.create({
      data: {
        ...t,
        recordTypeId: master.id,
        fieldId: status.id,
        steps: { open: { keyFields: ['last_name'], guidance: 'Call' } },
      },
    });
  });
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('loadTenantMetadata', () => {
  it('reads objects and live fields in order, with where each value is stored', async () => {
    const meta = await load(TENANT);
    expect(meta).toMatchObject({ tenantId: TENANT, version: 7 });
    expect(meta.objects.map((o) => o.apiName)).toEqual(['lead']);
    const lead = meta.objects[0];
    expect(lead).toMatchObject({
      table: 'lead',
      isStandard: true,
      labelKey: { singular: 'objects.lead.singular', plural: 'objects.lead.plural' },
      features: { history: true },
      compactFields: ['last_name', 'status'],
      autoNumbers: [{ field: 'record_number', format: 'L-{000000}' }],
    });
    expect(lead?.fields.map((f) => f.apiName)).toEqual([
      'record_number',
      'last_name',
      'status',
      'tier__c',
    ]);
    const byName = new Map(lead?.fields.map((f) => [f.apiName, f]));
    expect(byName.get('last_name')).toMatchObject({
      storage: { kind: 'column', column: 'last_name' },
      labelKey: 'objects.lead.fields.lastName',
      required: true,
    });
    expect(byName.get('tier__c')).toMatchObject({
      storage: { kind: 'custom', key: 'tier__c' },
      label: 'Tier',
      labelKey: null,
      trackHistory: true,
    });
  });

  it('labels catalogue picklist values by key and keeps admin labels', async () => {
    const lead = (await load(TENANT)).objects[0];
    const status = lead?.fields.find((f) => f.apiName === 'status');
    expect(status?.picklistValues).toEqual([
      {
        apiValue: 'open',
        label: null,
        labelKey: 'picklists.leadStatus.open',
        category: 'OPEN',
        active: true,
        isDefault: true,
      },
      {
        apiValue: 'working',
        label: 'In play',
        labelKey: 'picklists.leadStatus.working',
        category: 'WORKING',
        active: true,
        isDefault: false,
      },
    ]);
    const tier = lead?.fields.find((f) => f.apiName === 'tier__c');
    expect(tier?.picklistValues.map((v) => [v.apiValue, v.labelKey, v.active])).toEqual([
      ['gold', null, true],
      ['silver', null, false],
    ]);
  });

  it('reads record types with their values, layouts, rules and paths', async () => {
    const lead = (await load(TENANT)).objects[0];
    const vip = lead?.recordTypes.find((r) => r.apiName === 'vip');
    expect(vip?.picklistValues).toEqual({ tier__c: ['gold'], status: ['open'] });
    expect(lead?.recordTypes.find((r) => r.apiName === 'master')?.picklistValues).toEqual({});
    expect(lead?.layouts.map((l) => [l.name, l.isDefault])).toEqual([
      ['Lead layout', true],
      ['VIP layout', false],
    ]);
    expect(lead?.layoutAssignments).toHaveLength(1);
    expect(lead?.validationRules).toMatchObject([
      { apiName: 'needs_name', errorField: 'last_name', active: true },
    ]);
    expect(lead?.paths).toMatchObject([{ field: 'status', active: true }]);
  });

  it('sees nothing of another tenant', async () => {
    expect((await load(OTHER)).objects).toEqual([]);
  });
});
