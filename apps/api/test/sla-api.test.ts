import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];
let toRep = '';

beforeAll(async () => {
  f = await setupFixture('sla');
  const rule = await f.call('admin', 'POST', '/v1/setup/assignment-rules', {
    object: 'lead',
    name: 'To rep',
    entries: [{ method: 'SPECIFIC_USER', targetUserId: f.id('rep') }],
  });
  toRep = json(rule)['id'] as string;
});

afterAll(async () => {
  await f.api.dispose();
});

const policy = async (payload: Json = {}) => {
  const res = await f.call('admin', 'POST', '/v1/setup/sla-policies', {
    name: `Touch ${String(Math.random()).slice(2, 7)}`,
    metric: 'FIRST_TOUCH',
    targetMinutes: 60,
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number };
};

async function assignedLead() {
  const created = await f.call('admin', 'POST', '/v1/records/lead', {
    fields: { last_name: 'Clock', company: 'C' },
  });
  const id = json(created)['id'] as string;
  const run = await f.call('admin', 'POST', '/v1/assignment/run', {
    object: 'lead',
    recordIds: [id],
    ruleId: toRep,
  });
  expect(run.statusCode, run.body).toBe(200);
  return id;
}

describe('Setup → SLA policies', () => {
  it('creates, changes and deletes policies, audited', async () => {
    const p = await policy({
      name: 'First touch',
      criteria: { field: 'city', op: 'eq', value: 'Doha' },
    });
    expect(p).toMatchObject({
      object: 'lead',
      warnAtPercent: 50,
      managerAtPercent: 100,
      reassignAtPercent: null,
      criteria: { field: 'city', op: 'eq', value: 'Doha' },
    });
    const changed = await f.call('admin', 'PATCH', `/v1/setup/sla-policies/${p.id}`, {
      criteria: null,
      reassignAtPercent: 150,
      reassignRuleId: toRep,
      version: p.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json(changed)).toMatchObject({ reassignAtPercent: 150, reassignRuleId: toRep });
    expect(json(changed)['criteria']).toBeUndefined();
    expect(
      json(await f.call('viewer', 'GET', `/v1/setup/sla-policies/${p.id}`))['criteria'],
    ).toBeUndefined();
    expect(
      (await f.call('admin', 'PATCH', `/v1/setup/sla-policies/${p.id}`, { name: 'X', version: 1 }))
        .statusCode,
    ).toBe(409);
    expect((await f.call('admin', 'DELETE', `/v1/setup/sla-policies/${p.id}`)).statusCode).toBe(
      204,
    );
    expect(
      await f.inTenant((tx) => tx.prisma.setupAudit.count({ where: { entityType: 'sla_policy' } })),
    ).toBe(3);
  });

  it('refuses bad references, ladders and criteria', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/sla-policies', {
        name: 'Bad',
        metric: 'FIRST_TOUCH',
        targetMinutes: 60,
        ...payload,
      });
    expect(firstError(await post({ businessHoursId: f.id('admin') }))).toMatchObject({
      field: 'businessHoursId',
    });
    expect(firstError(await post({ reassignAtPercent: 150 }))).toMatchObject({
      field: 'reassignRuleId',
    });
    expect(
      firstError(await post({ criteria: { field: 'nope', op: 'eq', value: 1 } })),
    ).toMatchObject({
      field: 'criteria',
    });
    expect((await post({ targetMinutes: 0 })).statusCode).toBe(400);
    expect((await post({ warnAtPercent: 100 })).statusCode).toBe(400);
    expect((await post({ metric: 'RESOLVE' })).statusCode).toBe(400);
    await policy({ name: 'Taken' });
    expect((await post({ name: 'Taken' })).statusCode).toBe(409);
  });

  it('is guarded like the rest of Setup', async () => {
    const p = await policy();
    await f.expectGuarded('GET', '/v1/setup/sla-policies', {});
    await f.expectGuarded('GET', `/v1/setup/sla-policies/${p.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/sla-policies', {
      payload: { name: 'G', metric: 'QUALIFY', targetMinutes: 5 },
    });
    await f.expectGuarded('PATCH', `/v1/setup/sla-policies/${p.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/sla-policies/${p.id}`, {});
  });
});

describe('SLA clocks on leads', () => {
  it('starts at assignment, shows on the record and in chips, and stops on touch', async () => {
    await f.inTenant((tx) => tx.prisma.slaPolicy.deleteMany({}));
    await policy({ name: 'One hour' });
    const id = await assignedLead();
    const clocks = await f.call('rep', 'GET', `/v1/records/lead/${id}/sla`);
    expect(clocks.statusCode, clocks.body).toBe(200);
    expect(json(clocks)['items']).toEqual([
      expect.objectContaining({
        status: 'RUNNING',
        state: 'on_track',
        ownerId: f.id('rep'),
        policy: expect.objectContaining({ name: 'One hour', metric: 'FIRST_TOUCH' }) as unknown,
      }),
    ]);
    const chips = await f.call('rep', 'POST', '/v1/sla/status', { object: 'lead', ids: [id] });
    expect((json(chips)['items'] as Json[])[0]).toMatchObject({ recordId: id });
    const touched = await f.call('rep', 'POST', `/v1/records/lead/${id}/touch`);
    expect(touched.statusCode, touched.body).toBe(200);
    expect(json(touched)).toEqual({ met: 1 });
    const after = await f.call('rep', 'GET', `/v1/records/lead/${id}/sla`);
    expect((json(after)['items'] as Json[])[0]).toMatchObject({ status: 'MET', state: 'met' });
    expect(json(await f.call('rep', 'POST', `/v1/records/lead/${id}/touch`))).toEqual({ met: 0 });
  });

  it('keeps clocks to those who can see the lead', async () => {
    const id = await assignedLead();
    expect((await f.call('peer', 'POST', `/v1/records/lead/${id}/touch`)).statusCode).toBe(404);
    expect((await f.call('peer', 'GET', `/v1/records/lead/${id}/sla`)).statusCode).toBe(404);
    expect(
      json(await f.call('peer', 'POST', '/v1/sla/status', { object: 'lead', ids: [id] }))['items'],
    ).toEqual([]);
    expect((await f.call('outsider', 'POST', `/v1/records/lead/${id}/touch`)).statusCode).toBe(404);
    expect((await f.call('rep', 'POST', '/v1/records/lead/not-a-uuid/touch')).statusCode).toBe(400);
    expect(
      (await f.call('rep', 'POST', '/v1/sla/status', { object: 'lead', ids: [] })).statusCode,
    ).toBe(400);
  });
});
