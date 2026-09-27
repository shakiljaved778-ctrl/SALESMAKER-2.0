import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-0000000000f1';
const OTHER = '01920000-0000-7000-8000-0000000000f2';
const OWNER = '01920000-0000-7000-8000-0000000000f9';

let db: TestCellDatabase;
let prisma: CellPrisma;
const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);
const lead = (n: number, extra: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  recordNumber: `L-${String(n).padStart(6, '0')}`,
  ownerId: OWNER,
  lastName: 'Chen',
  firstName: 'Maya',
  company: 'Pixelcraft Studio',
  status: 'open',
  currencyCode: 'USD',
  ...extra,
});

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
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('core CRM tables (P02 T05)', () => {
  it('stores a lead with its §4.1 columns and keeps its search document current', async () => {
    const created = await inTenant(TENANT, ({ prisma: p }) =>
      p.lead.create({
        data: lead(1, { annualRevenue: '1250000.00', custom: { tier__c: 'gold' } }),
      }),
    );
    expect(created).toMatchObject({ version: 1, doNotCall: false, deletedAt: null });
    expect(created.annualRevenue?.toString()).toBe('1250000');
    const doc = () =>
      inTenant(TENANT, async ({ prisma: p }) => {
        const rows = await p.$queryRaw<{ doc: string }[]>`
          SELECT search_vector::text AS doc FROM lead WHERE id = ${created.id}::uuid`;
        return rows[0]?.doc ?? '';
      });
    expect(await doc()).toBe("'chen':2A 'maya':1A 'pixelcraft':3B 'studio':4B");
    await inTenant(TENANT, ({ prisma: p }) =>
      p.lead.update({
        where: { tenantId_id: { tenantId: TENANT, id: created.id } },
        data: { company: 'Aurelia Bank', email: 'maya@aurelia.example' },
      }),
    );
    // Only fields every reader sees are in the document: the company, not the email.
    expect(await doc()).toBe("'aurelia':3B 'bank':4B 'chen':2A 'maya':1A");
  });

  it('keeps record numbers and external ids unique per tenant', async () => {
    await inTenant(TENANT, ({ prisma: p }) =>
      p.lead.create({ data: lead(2, { externalId: 'crm-2' }) }),
    );
    await expect(
      inTenant(TENANT, ({ prisma: p }) => p.lead.create({ data: lead(2) })),
    ).rejects.toThrow();
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.lead.create({ data: lead(3, { externalId: 'crm-2' }) }),
      ),
    ).rejects.toThrow();
    // The same number and external id in another tenant is fine.
    await inTenant(OTHER, ({ prisma: p }) =>
      p.lead.create({ data: { ...lead(2, { externalId: 'crm-2' }), tenantId: OTHER } }),
    );
    expect(await inTenant(OTHER, ({ prisma: p }) => p.lead.count())).toBe(1);
  });

  it('checks currencies, custom values, probabilities and campaign members', async () => {
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.lead.create({ data: lead(10, { currencyCode: 'usd' }) }),
      ),
    ).rejects.toThrow();
    await expect(
      inTenant(TENANT, ({ prisma: p }) => p.lead.create({ data: lead(11, { custom: [1, 2] }) })),
    ).rejects.toThrow();
    const pipeline = await inTenant(TENANT, ({ prisma: p }) =>
      p.pipeline.create({ data: { tenantId: TENANT, name: 'Sales', isDefault: true } }),
    );
    const opp = (probability: number) =>
      inTenant(TENANT, ({ prisma: p }) =>
        p.opportunity.create({
          data: {
            tenantId: TENANT,
            recordNumber: `O-${String(probability)}`,
            ownerId: OWNER,
            name: 'Deal',
            pipelineId: pipeline.id,
            stage: 'proposal',
            forecastCategory: 'best_case',
            closeDate: new Date('2026-10-31'),
            currencyCode: 'QAR',
            probability,
          },
        }),
      );
    expect((await opp(50)).currencyCode).toBe('QAR');
    await expect(opp(101)).rejects.toThrow();
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.pipeline.create({ data: { tenantId: TENANT, name: 'Second', isDefault: true } }),
      ),
    ).rejects.toThrow();

    const campaign = await inTenant(TENANT, ({ prisma: p }) =>
      p.campaign.create({
        data: {
          tenantId: TENANT,
          recordNumber: 'CP-1',
          ownerId: OWNER,
          name: 'Launch',
          currencyCode: 'USD',
        },
      }),
    );
    expect(campaign.numberOfLeads).toBe(0);
    const someone = '01920000-0000-7000-8000-0000000000aa';
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.campaignMember.create({
          data: { tenantId: TENANT, campaignId: campaign.id, leadId: someone, contactId: someone },
        }),
      ),
    ).rejects.toThrow();
    await inTenant(TENANT, ({ prisma: p }) =>
      p.campaignMember.create({
        data: { tenantId: TENANT, campaignId: campaign.id, leadId: someone },
      }),
    );
  });

  it('keeps stage history append-only for the runtime role', async () => {
    const opportunityId = '01920000-0000-7000-8000-0000000000bb';
    await inTenant(TENANT, ({ prisma: p }) =>
      p.opportunityStageHistory.create({
        data: {
          tenantId: TENANT,
          opportunityId,
          stage: 'proposal',
          currencyCode: 'USD',
          closeDate: new Date('2026-10-31'),
          forecastCategory: 'best_case',
        },
      }),
    );
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.opportunityStageHistory.updateMany({ data: { stage: 'x' } }),
      ),
    ).rejects.toThrow();
    await expect(
      inTenant(TENANT, ({ prisma: p }) => p.opportunityStageHistory.deleteMany()),
    ).rejects.toThrow();
  });

  it('isolates tenants', async () => {
    const mine = await inTenant(TENANT, ({ prisma: p }) =>
      p.lead.findMany({ select: { id: true } }),
    );
    const seen = await inTenant(OTHER, ({ prisma: p }) =>
      p.lead.findMany({ where: { id: { in: mine.map((l) => l.id) } } }),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(seen).toEqual([]);
  });
});
