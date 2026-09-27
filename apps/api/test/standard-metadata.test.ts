import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import {
  CATALOGUE_VERSION,
  METADATA_OBJECTS,
  picklistLabelKeys,
  standardObject,
} from '@sm/metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syncStandardMetadata } from '../src/metadata/standard-metadata.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let alpha = '';
let beta = '';
const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);
const metadataVersion = (tenantId: string) =>
  inTenant(
    tenantId,
    async (tx) =>
      (await tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId } })).metadataVersion,
  );

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  alpha = await api.seedTenant('meta-alpha');
  beta = await api.seedTenant('meta-beta');
});

afterAll(async () => {
  await api.dispose();
});

describe('standard metadata sync (P02 T01)', () => {
  it('provisions every core object from the catalogue', async () => {
    const before = await metadataVersion(alpha);
    expect(await inTenant(alpha, syncStandardMetadata)).toBe(true);
    expect(await metadataVersion(alpha)).toBeGreaterThan(before);

    await inTenant(alpha, async ({ prisma: p }) => {
      const objects = await p.objectDefinition.findMany({ orderBy: { apiName: 'asc' } });
      expect(objects.map((o) => o.apiName)).toEqual([...METADATA_OBJECTS].sort());
      const lead = objects.find((o) => o.apiName === 'lead');
      expect(lead).toMatchObject({
        isStandard: true,
        recordNumberPrefix: 'L',
        icon: 'user-round-plus',
      });

      const fields = await p.fieldDefinition.findMany({ where: { objectId: lead?.id ?? '' } });
      expect(fields).toHaveLength(standardObject('lead')?.fields.length ?? -1);
      expect(fields.find((f) => f.apiName === 'email')).toMatchObject({
        type: 'email',
        searchable: true,
        isStandard: true,
      });
      expect(fields.find((f) => f.apiName === 'campaign_id')?.referenceTo).toEqual(['campaign']);

      const status = fields.find((f) => f.apiName === 'status');
      const values = await p.picklistValue.findMany({
        where: { fieldId: status?.id ?? '' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(values.map((v) => [v.apiValue, v.category])).toEqual([
        ['open', 'OPEN'],
        ['working', 'WORKING'],
        ['nurture', 'NURTURE'],
        ['qualified', 'QUALIFIED'],
        ['unqualified', 'UNQUALIFIED'],
        ['converted', 'CONVERTED'],
      ]);
      expect(values[0]?.isDefault).toBe(true);

      const leadId = lead?.id ?? '';
      expect(await p.recordType.findMany({ where: { objectId: leadId } })).toMatchObject([
        { apiName: 'master', name: 'Master', isDefault: true },
      ]);
      const layout = await p.pageLayout.findFirstOrThrow({ where: { objectId: leadId } });
      expect(layout).toMatchObject({ name: 'Lead layout', isDefault: true });
      const sections = layout.sections as { key: string; fields: { field: string }[] }[];
      expect(sections.map((s) => s.key)).toEqual(['details', 'address', 'description', 'system']);
      expect(sections[0]?.fields.map((f) => f.field)).toContain('company');
      expect(sections[0]?.fields.map((f) => f.field)).not.toContain('created_at');
      const compact = await p.compactLayout.findFirstOrThrow({ where: { objectId: leadId } });
      expect(compact.fields.length).toBeLessThanOrEqual(7);
      const recordNumber = fields.find((f) => f.apiName === 'record_number');
      expect(
        await p.autoNumberSequence.findUnique({
          where: { tenantId_fieldId: { tenantId: alpha, fieldId: recordNumber?.id ?? '' } },
        }),
      ).toMatchObject({ format: 'L-{000000}' });
      const views = await p.listView.findMany({
        where: { objectId: leadId },
        orderBy: { name: 'asc' },
      });
      expect(views.map((v) => [v.systemKey, v.name])).toEqual([
        ['all', 'All leads'],
        ['mine', 'My leads'],
        ['recent', 'Recently viewed'],
      ]);
      const settings = await p.tenantSettings.findUniqueOrThrow({ where: { tenantId: alpha } });
      expect(settings.catalogueVersion).toBe(CATALOGUE_VERSION);
    });
  });

  it('is idempotent and never overwrites what an admin changed', async () => {
    expect(await inTenant(alpha, syncStandardMetadata)).toBe(false);
    const counts = () =>
      inTenant(alpha, async ({ prisma: p }) => [
        await p.fieldDefinition.count(),
        await p.picklistValue.count(),
        await p.listView.count(),
        await p.pageLayout.count(),
      ]);
    const before = await counts();
    // An admin renames a value and a layout; a later catalogue revision syncs again.
    await inTenant(alpha, async ({ prisma: p }) => {
      await p.picklistValue.updateMany({ where: { apiValue: 'hot' }, data: { label: 'On fire' } });
      await p.pageLayout.updateMany({ data: { name: 'Renamed layout' } });
      await p.tenantSettings.update({ where: { tenantId: alpha }, data: { catalogueVersion: 0 } });
    });
    expect(await inTenant(alpha, syncStandardMetadata)).toBe(true);
    expect(await counts()).toEqual(before);
    await inTenant(alpha, async ({ prisma: p }) => {
      expect(await p.picklistValue.count({ where: { label: 'On fire' } })).toBe(2); // lead + account
      expect(await p.pageLayout.count({ where: { name: 'Renamed layout' } })).toBe(5);
    });
  });

  it('has a label for every default picklist value', () => {
    const t = serverTranslator('en') as unknown as { has(key: string): boolean };
    expect(picklistLabelKeys().filter((key) => !t.has(key))).toEqual([]);
  });

  it('keeps each tenant’s metadata to itself', async () => {
    expect(await inTenant(beta, ({ prisma: p }) => p.objectDefinition.count())).toBe(0);
    await inTenant(beta, syncStandardMetadata);
    const alphaIds = await inTenant(alpha, ({ prisma: p }) => p.objectDefinition.findMany());
    const seenFromBeta = await inTenant(beta, ({ prisma: p }) =>
      p.objectDefinition.findMany({ where: { id: { in: alphaIds.map((o) => o.id) } } }),
    );
    expect(seenFromBeta).toEqual([]);
  });
});

describe('metadata constraints', () => {
  const leadObjectId = (tenantId: string) =>
    inTenant(
      tenantId,
      async ({ prisma: p }) =>
        (
          await p.objectDefinition.findUniqueOrThrow({
            where: { tenantId_apiName: { tenantId, apiName: 'lead' } },
          })
        ).id,
    );

  it('numbers records per field and tenant from their own sequences', async () => {
    const next = (tenantId: string) =>
      inTenant(tenantId, async ({ prisma: p }) => {
        const field = await p.fieldDefinition.findFirstOrThrow({
          where: { apiName: 'record_number', object: { apiName: 'account' } },
        });
        const rows = await p.$queryRaw<
          { n: bigint }[]
        >`SELECT auto_number_next(${field.id}::uuid) AS n`;
        return Number(rows[0]?.n);
      });
    expect(await next(alpha)).toBe(1);
    expect(await next(alpha)).toBe(2);
    expect(await next(beta)).toBe(1);
  });

  it('enforces API names, the custom suffix and the tracked-field cap', async () => {
    const objectId = await leadObjectId(alpha);
    const field = (apiName: string, isStandard = false, trackHistory = false) => ({
      tenantId: alpha,
      objectId,
      apiName,
      isStandard,
      type: 'text' as const,
      trackHistory,
    });
    await expect(
      inTenant(alpha, ({ prisma: p }) => p.fieldDefinition.create({ data: field('Bad Name__c') })),
    ).rejects.toThrow();
    await expect(
      inTenant(alpha, ({ prisma: p }) => p.fieldDefinition.create({ data: field('no_suffix') })),
    ).rejects.toThrow();
    await expect(
      inTenant(alpha, ({ prisma: p }) =>
        p.fieldDefinition.create({ data: field('looks_custom__c', true) }),
      ),
    ).rejects.toThrow();
    await inTenant(alpha, ({ prisma: p }) =>
      p.fieldDefinition.createMany({
        data: Array.from({ length: 60 }, (_, i) => field(`tracked_${String(i)}__c`, false, true)),
      }),
    );
    await expect(
      inTenant(alpha, ({ prisma: p }) =>
        p.fieldDefinition.create({ data: field('tracked_60__c', false, true) }),
      ),
    ).rejects.toThrow(/60 tracked fields/);
  });
});
