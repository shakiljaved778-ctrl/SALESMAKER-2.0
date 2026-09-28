import { CURRENCY_RECALC_TOPIC } from '@sm/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;

beforeAll(async () => {
  f = await setupFixture('currency');
});

afterAll(async () => {
  await f.api.dispose();
});

const setupAudit = (action: string) =>
  f.inTenant(({ prisma }) => prisma.setupAudit.findMany({ where: { action } }));

describe('/v1/currencies (Q13)', () => {
  it('lists the corporate currency first, always active and without rates', async () => {
    const res = await f.call('admin', 'GET', '/v1/currencies');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      items: [
        {
          code: 'USD',
          name: expect.any(String) as unknown,
          minorUnits: 2,
          corporate: true,
          active: true,
          currentRate: null,
        },
      ],
    });
  });

  it('adds a currency once, and only a real one', async () => {
    const add = (code: string) => f.call('admin', 'POST', '/v1/currencies', { code });
    const res = await add('EUR');
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      code: 'EUR',
      corporate: false,
      active: true,
      currentRate: null,
    });
    expect((await add('EUR')).statusCode).toBe(409);
    expect((await add('USD')).statusCode).toBe(409);
    expect((await add('ZZZ')).statusCode).toBe(400);
    expect((await add('eur')).statusCode).toBe(400);
    expect(await setupAudit('currency.added')).toHaveLength(1);
  });

  it('deactivates and reactivates a currency, never the corporate one', async () => {
    const patch = (code: string, active: boolean) =>
      f.call('admin', 'PATCH', `/v1/currencies/${code}`, { active });
    expect(json(await patch('EUR', false))).toMatchObject({ code: 'EUR', active: false });
    expect(json(await patch('EUR', true))).toMatchObject({ active: true });
    expect((await patch('USD', false)).statusCode).toBe(409);
    expect((await patch('USD', true)).statusCode).toBe(200);
    expect((await patch('GBP', false)).statusCode).toBe(404);
    expect(await setupAudit('currency.deactivated')).toHaveLength(1);
  });

  it('sets dated rates and queues the recalculation of the amounts they govern', async () => {
    const put = (date: string, payload: Json) =>
      f.call('admin', 'PUT', `/v1/currencies/EUR/rates/${date}`, payload);
    const res = await put('2026-01-01', { rate: '0.92' });
    expect(res.statusCode).toBe(200);
    const body = json(res) as { rate: Json; recalculationJobId: string };
    expect(body.rate).toMatchObject({
      code: 'EUR',
      effectiveDate: '2026-01-01',
      rate: '0.92',
      version: 1,
    });
    const job = await f.inTenant(({ prisma }) =>
      prisma.jobRun.findFirstOrThrow({ where: { id: body.recalculationJobId } }),
    );
    expect(job).toMatchObject({ kind: 'currency_recalc', status: 'QUEUED' });
    const event = await f.inTenant(({ prisma }) =>
      prisma.outboxEvent.findFirstOrThrow({ where: { topic: CURRENCY_RECALC_TOPIC } }),
    );
    expect(event.payload).toEqual({ jobRunId: job.id, code: 'EUR', date: '2026-01-01' });

    // Correcting it: optimistic lock when a version is given.
    expect((await put('2026-01-01', { rate: '0.93', version: 7 })).statusCode).toBe(409);
    expect(json(await put('2026-01-01', { rate: '0.93', version: 1 }))).toMatchObject({
      rate: { rate: '0.93', version: 2 },
    });
    await put('2025-01-01', { rate: '0.85' });
    const rates = json(await f.call('viewer', 'GET', '/v1/currencies/EUR/rates'));
    expect(
      (rates['items'] as Json[]).map((r) => `${String(r['effectiveDate'])} ${String(r['rate'])}`),
    ).toEqual(['2026-01-01 0.93', '2025-01-01 0.85']);
    const list = json(await f.call('admin', 'GET', '/v1/currencies'));
    expect((list['items'] as Json[])[1]).toMatchObject({
      code: 'EUR',
      currentRate: { rate: '0.93' },
    });

    // Rates are positive decimals with up to 8 places, for currencies in use other than USD.
    expect((await put('2026-02-01', { rate: '0' })).statusCode).toBe(400);
    expect((await put('2026-02-01', { rate: '1.123456789' })).statusCode).toBe(400);
    expect((await put('2026-02-01', { rate: 1.1 })).statusCode).toBe(400);
    expect((await put('2026-02-30', { rate: '1.1' })).statusCode).toBe(400);
    expect(
      (await f.call('admin', 'PUT', '/v1/currencies/USD/rates/2026-02-01', { rate: '1' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await f.call('admin', 'PUT', '/v1/currencies/GBP/rates/2026-02-01', { rate: '1' }))
        .statusCode,
    ).toBe(404);
    expect(await setupAudit('currency_rate.updated')).toHaveLength(1);
  });

  it('removes a rate and queues the recalculation', async () => {
    const del = (date: string) => f.call('admin', 'DELETE', `/v1/currencies/EUR/rates/${date}`);
    const res = await del('2025-01-01');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      rate: null,
      recalculationJobId: expect.any(String) as unknown,
    });
    expect((await del('2025-01-01')).statusCode).toBe(404);
    expect((await f.call('admin', 'GET', '/v1/currencies/USD/rates')).statusCode).toBe(404);
    expect(await setupAudit('currency_rate.deleted')).toHaveLength(1);
  });

  it('is guarded, and another workspace sees none of it', async () => {
    await f.expectGuarded('GET', '/v1/currencies', {});
    await f.expectGuarded('GET', '/v1/currencies/EUR/rates', {});
    await f.expectGuarded('POST', '/v1/currencies', { payload: { code: 'JPY' } });
    await f.expectGuarded('PATCH', '/v1/currencies/EUR', { payload: { active: true } });
    await f.expectGuarded('PUT', '/v1/currencies/EUR/rates/2026-03-01', { payload: { rate: '1' } });
    await f.expectGuarded('DELETE', '/v1/currencies/EUR/rates/2026-01-01', {});
    // Cross-tenant: B's administrator does not see A's currency or rates.
    expect((await f.call('outsider', 'GET', '/v1/currencies/EUR/rates')).statusCode).toBe(404);
    expect(
      (await f.call('outsider', 'PATCH', '/v1/currencies/EUR', { active: false })).statusCode,
    ).toBe(404);
    expect(
      (await f.call('outsider', 'DELETE', '/v1/currencies/EUR/rates/2026-01-01')).statusCode,
    ).toBe(404);
    const theirs = json(await f.call('outsider', 'GET', '/v1/currencies'));
    expect((theirs['items'] as Json[]).map((c) => c['code'])).toEqual(['USD']);
  });
});
