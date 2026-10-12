import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];

beforeAll(async () => {
  f = await setupFixture('recycle');
});

afterAll(async () => {
  await f.api.dispose();
});

const create = async (payload: Json = {}) => {
  const res = await f.call('admin', 'POST', '/v1/setup/recycle-rules', {
    name: `Recycle ${String(Math.random()).slice(2, 7)}`,
    fromCategories: ['UNQUALIFIED'],
    afterDays: 30,
    targetStatus: 'open',
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number };
};

describe('Setup → lead recycling', () => {
  it('creates, changes and deletes rules, audited', async () => {
    const r = await create({
      name: 'Nurture back',
      fromCategories: ['NURTURE', 'UNQUALIFIED'],
      criteria: { field: 'city', op: 'eq', value: 'Doha' },
    });
    expect(r).toMatchObject({
      fromCategories: ['NURTURE', 'UNQUALIFIED'],
      afterDays: 30,
      active: true,
    });
    const changed = await f.call('admin', 'PATCH', `/v1/setup/recycle-rules/${r.id}`, {
      afterDays: 90,
      criteria: null,
      version: r.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json(changed)).toMatchObject({ afterDays: 90 });
    expect(json(changed)['criteria']).toBeUndefined();
    expect(
      (await f.call('admin', 'PATCH', `/v1/setup/recycle-rules/${r.id}`, { name: 'X', version: 1 }))
        .statusCode,
    ).toBe(409);
    expect((await f.call('admin', 'DELETE', `/v1/setup/recycle-rules/${r.id}`)).statusCode).toBe(
      204,
    );
    expect(
      await f.inTenant((tx) =>
        tx.prisma.setupAudit.count({ where: { entityType: 'recycle_rule' } }),
      ),
    ).toBe(3);
  });

  it('refuses closed target statuses, bad criteria and unknown rules', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/recycle-rules', {
        name: 'Bad',
        fromCategories: ['UNQUALIFIED'],
        afterDays: 30,
        targetStatus: 'open',
        ...payload,
      });
    expect(firstError(await post({ targetStatus: 'qualified' }))).toMatchObject({
      code: 'not_open',
    });
    expect(firstError(await post({ targetStatus: 'nope' }))).toMatchObject({
      field: 'targetStatus',
    });
    expect(
      firstError(await post({ criteria: { field: 'nope', op: 'eq', value: 1 } })),
    ).toMatchObject({
      field: 'criteria',
    });
    expect(firstError(await post({ assignmentRuleId: f.id('admin') }))).toMatchObject({
      field: 'assignmentRuleId',
    });
    expect((await post({ fromCategories: ['QUALIFIED'] })).statusCode).toBe(400);
    expect((await post({ afterDays: 0 })).statusCode).toBe(400);
    await create({ name: 'Taken' });
    expect((await post({ name: 'Taken' })).statusCode).toBe(409);
  });

  it('is guarded like the rest of Setup', async () => {
    const r = await create();
    await f.expectGuarded('GET', '/v1/setup/recycle-rules', {});
    await f.expectGuarded('GET', `/v1/setup/recycle-rules/${r.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/recycle-rules', {
      payload: { name: 'G', fromCategories: ['NURTURE'], afterDays: 5, targetStatus: 'open' },
    });
    await f.expectGuarded('PATCH', `/v1/setup/recycle-rules/${r.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/recycle-rules/${r.id}`, {});
  });
});
