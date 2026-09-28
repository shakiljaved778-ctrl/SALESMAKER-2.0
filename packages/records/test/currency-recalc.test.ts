import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  recalculateCorporateAmounts,
  tenantCurrencyConverter,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d06';
let h: Harness;
let user = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await startHarness(T);
  user = await h.user('rep');
  // The same rates as the harness's converter, so records start consistent.
  await h.inTenant(async ({ prisma }) => {
    await prisma.tenantCurrency.create({ data: { tenantId: T, code: 'EUR' } });
    await prisma.currencyRate.createMany({
      data: [
        { tenantId: T, code: 'EUR', effectiveDate: new Date('2026-01-01'), rate: '0.80' },
        { tenantId: T, code: 'EUR', effectiveDate: new Date('2026-10-01'), rate: '0.90' },
      ],
    });
  });
  const create = (object: string, fields: Record<string, unknown>, currencyCode = 'EUR') =>
    h.inTenant(async (tx) => {
      const ctx = await h.context(tx, user);
      return (await createRecord(tx, ctx, object, { fields, currencyCode })).id;
    });
  const opp = (amount: string, close: string) =>
    create('opportunity', {
      name: `Deal ${close}`,
      amount,
      close_date: close,
      stage: 'qualification',
    });
  ids['june'] = await opp('1000', '2026-06-15');
  ids['november'] = await opp('900', '2026-11-01');
  ids['account'] = await create('account', { name: 'Stark', annual_revenue: '800' });
  ids['usd'] = await create('account', { name: 'Wayne', annual_revenue: '800' }, 'USD');
});

afterAll(async () => {
  await h.dispose();
});

const corporate = (object: string, id: string, field: string) =>
  h.inTenant(async (tx) => {
    const ctx = await h.context(tx, user);
    const meta = ctx.metadata.object(object);
    if (!meta) throw new Error(object);
    const rows = await tx.prisma.$queryRawUnsafe<{ v: string | null; d: string | null }[]>(
      `SELECT ${field}_corporate::text AS v, to_char(corporate_rate_date, 'YYYY-MM-DD') AS d
         FROM ${meta.table} WHERE id = $1::uuid`,
      id,
    );
    return rows[0] ? `${rows[0].v ?? 'null'} @${rows[0].d ?? 'null'}` : 'missing';
  });
const snapshot = async () => ({
  june: await corporate('opportunity', ids['june'] ?? '', 'amount'),
  november: await corporate('opportunity', ids['november'] ?? '', 'amount'),
  account: await corporate('account', ids['account'] ?? '', 'annual_revenue'),
  usd: await corporate('account', ids['usd'] ?? '', 'annual_revenue'),
});
const rate = (date: string, value: string | null) =>
  h.inTenant(async ({ prisma }) => {
    if (value === null)
      await prisma.currencyRate.deleteMany({
        where: { code: 'EUR', effectiveDate: new Date(date) },
      });
    else
      await prisma.currencyRate.upsert({
        where: {
          tenantId_code_effectiveDate: { tenantId: T, code: 'EUR', effectiveDate: new Date(date) },
        },
        create: { tenantId: T, code: 'EUR', effectiveDate: new Date(date), rate: value },
        update: { rate: value },
      });
  });
const recalc = async (date: string) => {
  const run = await h.inTenant(({ prisma }) =>
    prisma.jobRun.create({ data: { tenantId: T, kind: 'currency_recalc' } }),
  );
  const updated = await recalculateCorporateAmounts((fn) => h.inTenant(fn), {
    jobRunId: run.id,
    code: 'EUR',
    date,
  });
  const job = await h.inTenant(({ prisma }) =>
    prisma.jobRun.findFirstOrThrow({ where: { id: run.id } }),
  );
  expect(job).toMatchObject({ status: 'SUCCEEDED', done: updated });
  // A finished job is not run again.
  expect(
    await recalculateCorporateAmounts((fn) => h.inTenant(fn), {
      jobRunId: run.id,
      code: 'EUR',
      date,
    }),
  ).toBe(0);
  return updated;
};

describe('corporate amounts after a rate change (Q13)', () => {
  it('starts from the rates in force when the values were written', async () => {
    expect(await snapshot()).toEqual({
      june: '1250.00 @2026-01-01',
      november: '1000.00 @2026-10-01',
      account: '1000.00 @2026-01-01',
      usd: '800.00 @2026-09-27',
    });
  });

  it('a corrected rate moves the amounts it governed, and only those', async () => {
    await rate('2026-01-01', '0.50');
    expect(await recalc('2026-01-01')).toBe(2);
    expect(await snapshot()).toEqual({
      june: '2000.00 @2026-01-01',
      november: '1000.00 @2026-10-01',
      account: '1600.00 @2026-01-01',
      usd: '800.00 @2026-09-27',
    });
  });

  it('a new rate moves opportunity amounts closing after it, not money set earlier', async () => {
    await rate('2026-05-01', '0.40');
    expect(await recalc('2026-05-01')).toBe(1);
    expect(await snapshot()).toMatchObject({
      june: '2500.00 @2026-05-01',
      account: '1600.00 @2026-01-01',
    });
  });

  it('a removed rate hands its amounts back to the previous rate, or to none', async () => {
    await rate('2026-05-01', null);
    await recalc('2026-05-01');
    expect(await snapshot()).toMatchObject({ june: '2000.00 @2026-01-01' });
    await rate('2026-01-01', null);
    await recalc('2026-01-01');
    expect(await snapshot()).toEqual({
      june: 'null @null',
      november: '1000.00 @2026-10-01',
      account: 'null @null',
      usd: '800.00 @2026-09-27',
    });
  });

  it('matches what RecordService writes for the same rates', async () => {
    await h.inTenant(async (tx) => {
      const fx = tenantCurrencyConverter(tx, 'USD');
      expect(await fx.toCorporate('900', 'EUR', '2026-11-01')).toEqual({
        amount: '1000.00',
        rateDate: '2026-10-01',
      });
    });
  });
});
