import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  loadRecordContext,
  MASS_ACTION_TOPIC,
  previewMassAction,
  readStored,
  RecordError,
  runMassAction,
  startMassAction,
  tenantCurrencyConverter,
  type MassAction,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d04';
let h: Harness;
const users: Record<string, string> = {};
const NOW = () => new Date('2026-09-27T10:00:00Z');

beforeAll(async () => {
  h = await startHarness(T);
  await h.unit('sales');
  await h.unit('emea', 'sales');
  users['boss'] = await h.user('boss', 'sales');
  users['rep'] = await h.user('rep', 'emea');
  users['plain'] = await h.user('plain', 'sales');
  await h.grant(users['boss'] ?? '', { system: ['mass_update', 'transfer_records'] });
  await h.grant(users['rep'] ?? '');
  await h.inTenant(async ({ prisma }) => {
    await prisma.user.update({
      where: { tenantId_id: { tenantId: T, id: users['boss'] ?? '' } },
      data: { title: 'VP Sales', timezone: 'Asia/Dubai' },
    });
    await prisma.tenantCurrency.create({ data: { tenantId: T, code: 'EUR' } });
    await prisma.currencyRate.createMany({
      data: [
        { tenantId: T, code: 'EUR', effectiveDate: new Date('2026-01-01'), rate: '0.80' },
        { tenantId: T, code: 'EUR', effectiveDate: new Date('2026-10-01'), rate: '0.90' },
      ],
    });
    await prisma.orgWideDefault.create({
      data: { tenantId: T, object: 'lead', sharingModel: 'PUBLIC_READ', grantHierarchy: true },
    });
  });
});

afterAll(async () => {
  await h.dispose();
});

const lead = (user: string, fields: Record<string, unknown>) =>
  h.inTenant(async (tx) => {
    const ctx = await loadRecordContext(tx, users[user] ?? '', { now: NOW });
    return (await createRecord(tx, ctx, 'lead', { fields })).id;
  });
const stored = (id: string) =>
  h.inTenant(async (tx) => {
    const ctx = await h.context(tx, users['boss'] ?? '', { system: ['modify_all_data'] });
    const meta = ctx.metadata.object('lead');
    if (!meta) throw new Error('lead');
    return readStored(tx, meta, id, { includeDeleted: true });
  });
const start = (user: string, spec: unknown) =>
  h.inTenant(async (tx) =>
    startMassAction(tx, await loadRecordContext(tx, users[user] ?? '', { now: NOW }), spec),
  );
const run = async (jobRunId: string) => {
  const event = await h.inTenant(({ prisma }) =>
    prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: jobRunId } }),
  );
  expect(event.topic).toBe(MASS_ACTION_TOPIC);
  await runMassAction((fn) => h.inTenant(fn), event.payload, { now: NOW });
  return h.inTenant(({ prisma }) => prisma.jobRun.findFirstOrThrow({ where: { id: jobRunId } }));
};

describe('loadRecordContext', () => {
  it('loads the user’s permissions, sharing, globals and currencies from the database', async () => {
    await h.inTenant(async (tx) => {
      const ctx = await loadRecordContext(tx, users['boss'] ?? '', { requestId: 'req-1' });
      expect(ctx.permissions.system.has('mass_update')).toBe(true);
      expect(ctx.permissions.objects['lead']?.edit).toBe(true);
      expect(ctx.sharing.objectSharing('lead').sharingModel).toBe('PUBLIC_READ');
      expect(ctx.sharing.objectSharing('account').sharingModel).toBe('PRIVATE');
      expect(ctx.sharing.objectSharing('contact').parents).toEqual([
        { field: 'account_id', object: 'account' },
      ]);
      expect(() => ctx.sharing.objectSharing('widget')).toThrow(/no sharing settings/);
      expect(ctx.sharing.bypasses('lead', 'read')).toBe(false);
      expect(ctx.timezone).toBe('Asia/Dubai');
      expect(ctx.globals('User', 'title')).toBe('VP Sales');
      expect(ctx.globals('Org', 'corporate_currency')).toBe('USD');
      expect(ctx.globals('Org', 'nothing')).toBeNull();
      expect(ctx.requestId).toBe('req-1');
      // A user with no profile holds nothing and falls back to the org's time zone.
      const plain = await loadRecordContext(tx, users['plain'] ?? '');
      expect(plain.permissions.objects['lead']).toBeUndefined();
      expect(plain.timezone).toBe('UTC');
    });
  });

  it('converts with the dated rates in force on the day', async () => {
    await h.inTenant(async (tx) => {
      const fx = tenantCurrencyConverter(tx, 'USD');
      expect(await fx.toCorporate('100', 'EUR', '2026-06-01')).toEqual({
        amount: '125.00',
        rateDate: '2026-01-01',
      });
      expect(await fx.toCorporate('90', 'EUR', '2026-10-02')).toEqual({
        amount: '100.00',
        rateDate: '2026-10-01',
      });
      expect(await fx.toCorporate('1', 'EUR', '2025-12-31')).toBeNull();
      expect(await fx.toCorporate('12.345', 'USD', '2026-06-01')).toEqual({
        amount: '12.35',
        rateDate: '2026-06-01',
      });
      expect(await fx.isActive('EUR')).toBe(true);
      expect(await fx.isActive('USD')).toBe(true);
      expect(await fx.isActive('GBP')).toBe(false);
    });
  });
});

describe('mass action jobs (§7.5: select all matching up to 10k)', () => {
  it('previews, queues and runs a mass update with progress', async () => {
    const ids = [
      await lead('rep', { last_name: 'J1', company: 'Job' }),
      await lead('rep', { last_name: 'J2', company: 'Job' }),
      await lead('boss', { last_name: 'J3', company: 'Job' }),
    ];
    const spec: MassAction = {
      object: 'lead',
      where: { field: 'company', op: 'eq', value: 'Job' },
      action: { kind: 'update', fields: { rating: 'warm' } },
    };
    const preview = await h.inTenant(async (tx) =>
      previewMassAction(tx, await loadRecordContext(tx, users['boss'] ?? ''), spec),
    );
    expect(preview).toEqual({ count: 3, tooMany: false });
    const { jobRunId, total } = await start('boss', spec);
    expect(total).toBe(3);
    const job = await run(jobRunId);
    expect(job).toMatchObject({
      kind: 'mass_update',
      status: 'SUCCEEDED',
      done: 3,
      failed: 0,
      total: 3,
      createdBy: users['boss'],
    });
    for (const id of ids) expect((await stored(id))?.values['rating']).toBe('warm');
    // A finished job is not run again.
    await h.inTenant(({ prisma }) =>
      prisma.jobRun.update({
        where: { tenantId_id: { tenantId: T, id: jobRunId } },
        data: { done: 99 },
      }),
    );
    expect((await run(jobRunId)).done).toBe(99);
  });

  it('records the rows that failed', async () => {
    const mine = await lead('rep', { last_name: 'F1', company: 'Fail' });
    const missing = '01920000-0000-7000-8000-00000000dead';
    const { jobRunId } = await start('boss', {
      object: 'lead',
      ids: [mine, missing],
      action: { kind: 'transfer', ownerId: users['boss'], opportunities: 'all', keepTeams: true },
    });
    const job = await run(jobRunId);
    expect(job).toMatchObject({ status: 'SUCCEEDED', done: 2, failed: 1 });
    expect(job.result).toEqual({
      failures: [{ id: missing, status: 404, errors: [] }],
    });
    expect((await stored(mine))?.values['owner_id']).toBe(users['boss']);
  });

  it('refuses what the user may not do, before and while running', async () => {
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        if (err instanceof RecordError)
          return `${String(err.status)} ${err.errors.map((e) => e.code).join()}`;
        throw err;
      }
      return 'accepted';
    };
    const del = { object: 'lead', action: { kind: 'delete' } };
    expect(await refusal(start('rep', del))).toBe('403 needs_modify_all');
    expect(await refusal(start('rep', { ...del, action: { kind: 'update', fields: {} } }))).toBe(
      '403 needs_mass_update',
    );
    expect(
      await refusal(start('rep', { ...del, action: { kind: 'transfer', ownerId: users['rep'] } })),
    ).toBe('403 needs_transfer_records');
    expect(await refusal(start('rep', { ...del, object: 'widget' }))).toBe('404 ');
    expect(
      await refusal(
        start('boss', { ...del, ids: [users['rep']], where: { field: 'id', op: 'is_not_null' } }),
      ),
    ).toBe('400 invalid');

    // Queued while allowed, run after the permission went away: the job fails, nothing changes.
    const target = await lead('boss', { last_name: 'Late', company: 'Late' });
    const { jobRunId } = await start('boss', {
      object: 'lead',
      ids: [target],
      action: { kind: 'update', fields: { rating: 'cold' } },
    });
    await h.inTenant(({ prisma }) =>
      prisma.systemPermission.deleteMany({ where: { name: 'mass_update' } }),
    );
    const job = await run(jobRunId);
    expect(job).toMatchObject({ status: 'FAILED', error: 'forbidden' });
    expect((await stored(target))?.values['rating']).toBeNull();
  });
});
