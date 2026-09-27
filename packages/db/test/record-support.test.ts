import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '../src/client.js';
import { fieldHistory } from '../src/field-history.js';
import { withTenant, type TenantTransaction } from '../src/tenant.js';
import { createTestCellDatabase, type TestCellDatabase } from '../src/testing/cell-database.js';

const TENANT = '01920000-0000-7000-8000-000000000a11';
const OTHER = '01920000-0000-7000-8000-000000000a12';
const RECORD = '01920000-0000-7000-8000-000000000a1f';
const USER = '01920000-0000-7000-8000-000000000a1e';

let db: TestCellDatabase;
let prisma: CellPrisma;
const inTenant = <T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId }, fn);

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

describe('field history (§7.17)', () => {
  it('keeps monthly partitions ahead, idempotently', async () => {
    // The migration created this month and the next three; running again makes nothing new.
    expect(await fieldHistory.maintainPartitions(prisma)).toEqual([]);
    const parts = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'field_history'::regclass ORDER BY 1`;
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts[0]?.name).toMatch(/^field_history_p\d{6}$/);
  });

  it('records changes and never lets the runtime role rewrite them', async () => {
    await inTenant(TENANT, ({ prisma: p }) =>
      p.fieldHistory.create({
        data: {
          tenantId: TENANT,
          object: 'lead',
          recordId: RECORD,
          field: 'status',
          oldValue: 'open',
          newValue: 'working',
          changedBy: USER,
        },
      }),
    );
    const rows = await inTenant(TENANT, ({ prisma: p }) =>
      p.fieldHistory.findMany({ where: { recordId: RECORD } }),
    );
    expect(rows).toMatchObject([{ field: 'status', oldValue: 'open', newValue: 'working' }]);
    await expect(
      inTenant(TENANT, ({ prisma: p }) => p.fieldHistory.updateMany({ data: { field: 'x' } })),
    ).rejects.toThrow();
    await expect(
      inTenant(TENANT, ({ prisma: p }) => p.fieldHistory.deleteMany()),
    ).rejects.toThrow();
    expect(await inTenant(OTHER, ({ prisma: p }) => p.fieldHistory.count())).toBe(0);
  });
});

describe('recycle bin, recent items, currencies and teams', () => {
  it('holds one bin item per record, purged only after it was deleted', async () => {
    const now = new Date();
    const item = {
      tenantId: TENANT,
      object: 'lead',
      recordId: RECORD,
      name: 'Maya Chen',
      deletedAt: now,
      purgeAfter: new Date(now.getTime() + 30 * 86_400_000),
    };
    await inTenant(TENANT, ({ prisma: p }) => p.recycleBinItem.create({ data: item }));
    await expect(
      inTenant(TENANT, ({ prisma: p }) => p.recycleBinItem.create({ data: item })),
    ).rejects.toThrow();
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.recycleBinItem.create({ data: { ...item, recordId: USER, purgeAfter: now } }),
      ),
    ).rejects.toThrow();
  });

  it('keeps the latest view of a record once per user', async () => {
    const view = (viewedAt: Date) =>
      inTenant(TENANT, ({ prisma: p }) =>
        p.recentItem.upsert({
          where: {
            tenantId_userId_object_recordId: {
              tenantId: TENANT,
              userId: USER,
              object: 'lead',
              recordId: RECORD,
            },
          },
          create: { tenantId: TENANT, userId: USER, object: 'lead', recordId: RECORD, viewedAt },
          update: { viewedAt },
        }),
      );
    await view(new Date('2026-09-01T00:00:00Z'));
    await view(new Date('2026-09-27T00:00:00Z'));
    const items = await inTenant(TENANT, ({ prisma: p }) => p.recentItem.findMany());
    expect(items).toHaveLength(1);
    expect(items[0]?.viewedAt.toISOString()).toBe('2026-09-27T00:00:00.000Z');
  });

  it('takes known currencies and positive, dated rates', async () => {
    await inTenant(TENANT, ({ prisma: p }) =>
      p.tenantCurrency.create({ data: { tenantId: TENANT, code: 'QAR' } }),
    );
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.tenantCurrency.create({ data: { tenantId: TENANT, code: 'XXX' } }),
      ),
    ).rejects.toThrow();
    const rate = (effectiveDate: string, value: string) =>
      inTenant(TENANT, ({ prisma: p }) =>
        p.currencyRate.create({
          data: {
            tenantId: TENANT,
            code: 'QAR',
            effectiveDate: new Date(effectiveDate),
            rate: value,
          },
        }),
      );
    expect((await rate('2026-01-01', '3.64000000')).rate.toString()).toBe('3.64');
    await expect(rate('2026-01-01', '3.65')).rejects.toThrow(); // one rate per day
    await expect(rate('2026-02-01', '0')).rejects.toThrow();
  });

  it('limits team access to read or edit', async () => {
    const member = (access: number, opportunityAccess = 0) =>
      inTenant(TENANT, ({ prisma: p }) =>
        p.accountTeamMember.create({
          data: { tenantId: TENANT, accountId: RECORD, userId: USER, access, opportunityAccess },
        }),
      );
    await expect(member(3)).rejects.toThrow();
    await expect(member(1, 3)).rejects.toThrow();
    await member(2, 1);
    await expect(member(1)).rejects.toThrow(); // one membership per user and account
    await expect(
      inTenant(TENANT, ({ prisma: p }) =>
        p.opportunityTeamMember.create({
          data: { tenantId: TENANT, opportunityId: RECORD, userId: USER, access: 0 },
        }),
      ),
    ).rejects.toThrow();
  });
});
