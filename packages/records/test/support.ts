import {
  createCellPrisma,
  disposeCellPrisma,
  loadTenantMetadata,
  principalsOf,
  visibility,
  withTenant,
  type CellPrisma,
  type TenantTransaction,
} from '@sm/db';
import { createTestCellDatabase, type TestCellDatabase } from '@sm/db/testing';
import {
  DEFAULT_PIPELINE_STAGES,
  defaultPicklistValues,
  MetadataIndex,
  METADATA_OBJECTS,
  standardObject,
} from '@sm/metadata';
import { effectivePermissions, type Grants, type ObjectAccess } from '@sm/permissions';
import type { ObjectSharing } from '@sm/query-engine';
import { Decimal } from 'decimal.js';
import { inject } from 'vitest';

import type { CurrencyConverter, RecordContext } from '../src/index.js';

export const FULL: ObjectAccess = {
  read: true,
  create: true,
  edit: true,
  delete: true,
  viewAll: false,
  modifyAll: false,
};

export interface Harness {
  db: TestCellDatabase;
  prisma: CellPrisma;
  tenantId: string;
  inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  /** A user in a unit (null: none), for sharing. */
  user(name: string, unit?: string | null): Promise<string>;
  unit(name: string, parent?: string | null): Promise<string>;
  context(tx: TenantTransaction, userId: string, grants?: Partial<Grants>): Promise<RecordContext>;
  dispose(): Promise<void>;
}

/** Rates: units per one USD (the corporate currency). */
const RATES: Record<string, [string, string][]> = {
  EUR: [
    ['2026-01-01', '0.80'],
    ['2026-10-01', '0.90'],
  ],
};

export const fakeCurrency: CurrencyConverter = {
  toCorporate(amount, code, date) {
    if (code === 'USD') return Promise.resolve({ amount, rateDate: date });
    const rate = (RATES[code] ?? []).filter(([d]) => d <= date).at(-1);
    if (!rate) return Promise.resolve(null);
    return Promise.resolve({
      amount: new Decimal(amount).div(rate[1]).toFixed(2),
      rateDate: rate[0],
    });
  },
  isActive: (code) => Promise.resolve(code === 'USD' || code === 'EUR'),
};

/** A cell database with one tenant whose standard metadata is provisioned from the catalogue. */
export async function startHarness(tenantId: string): Promise<Harness> {
  const db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  const prisma = createCellPrisma(db.appUrl);
  const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
    withTenant(prisma, { tenantId }, fn);
  await inTenant(async ({ prisma: p }) => {
    await p.tenantSettings.create({
      data: {
        tenantId,
        name: 'records',
        slug: `rec-${tenantId.slice(-4)}`,
        region: 'eu-central-1',
        corporateCurrency: 'USD',
        defaultTimezone: 'UTC',
      },
    });
    const pipeline = await p.pipeline.create({
      data: { tenantId, name: 'Sales', isDefault: true },
    });
    await p.pipelineStage.createMany({
      data: DEFAULT_PIPELINE_STAGES.map((s, i) => ({
        tenantId,
        pipelineId: pipeline.id,
        apiValue: s.apiValue,
        label: s.apiValue,
        sortOrder: i,
        category: s.category,
        probability: s.probability,
        forecastCategory: s.forecastCategory,
      })),
    });
    for (const apiName of METADATA_OBJECTS) {
      const def = standardObject(apiName);
      if (!def) continue;
      const object = await p.objectDefinition.create({
        data: {
          tenantId,
          apiName,
          isStandard: true,
          icon: def.icon,
          color: def.color,
          recordNumberPrefix: def.recordNumberPrefix,
          nameField: def.nameField,
        },
      });
      for (const [i, f] of def.fields.entries()) {
        const field = await p.fieldDefinition.create({
          data: {
            tenantId,
            objectId: object.id,
            apiName: f.apiName,
            isStandard: true,
            type: f.type,
            required: f.required,
            system: f.system,
            referenceTo: [...(f.references ?? [])],
            sortOrder: i,
          },
        });
        const values = defaultPicklistValues(apiName, f.apiName);
        if (values.length)
          await p.picklistValue.createMany({
            data: values.map((v, j) => ({
              tenantId,
              fieldId: field.id,
              apiValue: v.apiValue,
              category: v.category ?? null,
              isDefault: v.isDefault,
              sortOrder: j,
            })),
          });
        if (f.apiName === 'record_number')
          await p.autoNumberSequence.create({
            data: { tenantId, fieldId: field.id, format: `${def.recordNumberPrefix}-{000000}` },
          });
      }
      await p.recordType.create({
        data: {
          tenantId,
          objectId: object.id,
          apiName: 'master',
          name: 'Master',
          isDefault: true,
          pipelineId: apiName === 'opportunity' ? pipeline.id : null,
        },
      });
    }
  });

  const units = new Map<string, string>();
  return {
    db,
    prisma,
    tenantId,
    inTenant,
    async unit(name, parent = null) {
      const u = await inTenant(({ prisma: p }) =>
        p.orgUnit.create({
          data: { tenantId, name, parentId: parent ? (units.get(parent) ?? null) : null },
        }),
      );
      units.set(name, u.id);
      return u.id;
    },
    async user(name, unit = null) {
      return inTenant(async (tx) => {
        const u = await tx.prisma.user.create({
          data: {
            tenantId,
            email: `${name}@records.test`,
            name,
            status: 'ACTIVE',
            orgUnitId: unit ? (units.get(unit) ?? null) : null,
          },
        });
        await visibility.rebuild(tx);
        return u.id;
      });
    },
    async context(tx, userId, grants = {}) {
      const settings = await tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
      const metadata = new MetadataIndex(await loadTenantMetadata(tx, settings.metadataVersion));
      const full: Grants = {
        system: grants.system ?? [],
        objects: grants.objects ?? {
          lead: FULL,
          account: FULL,
          contact: FULL,
          opportunity: FULL,
          campaign: FULL,
        },
        fields: grants.fields ?? allFields(),
      };
      const sharing: Record<string, ObjectSharing> = Object.fromEntries(
        METADATA_OBJECTS.map((o) => [
          o,
          { object: o, table: o, sharingModel: 'PRIVATE', grantHierarchy: true },
        ]),
      );
      return {
        userId,
        metadata,
        permissions: effectivePermissions({ profile: full, sets: [], groups: [] }),
        sharing: {
          tenantId,
          principals: await principalsOf(tx, userId),
          objectSharing: (o) =>
            sharing[o] ?? { object: o, table: o, sharingModel: 'PRIVATE', grantHierarchy: true },
          bypasses: (_o, level) =>
            full.system.includes('modify_all_data') ||
            (level === 'read' && full.system.includes('view_all_data')),
        },
        corporateCurrency: 'USD',
        timezone: 'UTC',
        currency: fakeCurrency,
        globals: (scope, name) => (scope === 'User' && name === 'id' ? userId : null),
        now: () => new Date('2026-09-27T10:00:00Z'),
      };
    },
    async dispose() {
      await disposeCellPrisma(prisma);
      await db.drop();
    },
  };
}

/** Read and edit on every non-system standard field (tests hide some explicitly). */
export function allFields(hidden: Record<string, string[]> = {}): Grants['fields'] {
  return Object.fromEntries(
    METADATA_OBJECTS.map((o) => [
      o,
      Object.fromEntries(
        (standardObject(o)?.fields ?? [])
          .filter((f) => !f.system && !(hidden[o] ?? []).includes(f.apiName))
          .map((f) => [f.apiName, { read: true, edit: true }]),
      ),
    ]),
  );
}
