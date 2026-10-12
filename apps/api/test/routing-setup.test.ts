import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];

beforeAll(async () => {
  f = await setupFixture('routing');
});

afterAll(async () => {
  await f.api.dispose();
});

const week = {
  sun: [
    ['08:00', '12:00'],
    ['13:00', '17:00'],
  ],
  mon: [['08:00', '17:00']],
};
const create = async (payload: Json = {}) => {
  const res = await f.call('admin', 'POST', '/v1/setup/business-hours', {
    name: `Doha ${String(Math.random()).slice(2, 7)}`,
    timezone: 'Asia/Qatar',
    hours: week,
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number };
};

describe('Setup → business hours', () => {
  it('creates sets with holidays, keeps one default, changes and deletes them, audited', async () => {
    const a = await create({
      name: 'Doha office',
      isDefault: true,
      holidays: [{ date: '2026-12-18', name: 'National Day', recurring: true }],
    });
    expect(a).toMatchObject({
      isDefault: true,
      holidays: [{ date: '2026-12-18', name: 'National Day', recurring: true }],
    });
    const b = await create({ isDefault: true });
    expect(json(await f.call('viewer', 'GET', `/v1/setup/business-hours/${a.id}`))).toMatchObject({
      isDefault: false,
      version: a.version + 1,
    });
    const changed = await f.call('admin', 'PATCH', `/v1/setup/business-hours/${b.id}`, {
      holidays: [{ date: '2026-10-14', name: 'Closed' }],
      hours: { mon: [['09:00', '24:00']] },
      version: b.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json(changed)).toMatchObject({
      hours: { mon: [['09:00', '24:00']] },
      holidays: [{ date: '2026-10-14', recurring: false }],
    });
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/setup/business-hours/${b.id}`, {
          name: 'X',
          version: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.call('admin', 'DELETE', `/v1/setup/business-hours/${b.id}`)).statusCode).toBe(
      204,
    );
    const listed = await f.call('viewer', 'GET', '/v1/setup/business-hours');
    expect((json(listed)['items'] as Json[]).map((x) => x['id'])).toEqual([a.id]);
    const audited = await f.inTenant((tx) =>
      tx.prisma.setupAudit.count({ where: { entityType: 'business_hours' } }),
    );
    expect(audited).toBeGreaterThanOrEqual(4);
  });

  it('refuses bad hours, zones, duplicate holidays and taken names', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/business-hours', {
        name: 'Bad',
        timezone: 'Asia/Qatar',
        hours: week,
        ...payload,
      });
    expect(firstError(await post({ timezone: 'Mars/Olympus' }))).toMatchObject({
      field: 'timezone',
    });
    expect(firstError(await post({ hours: { mon: [['17:00', '08:00']] } }))).toMatchObject({
      field: 'hours.mon.0',
      code: 'ends_before_start',
    });
    expect(
      firstError(
        await post({
          hours: {
            mon: [
              ['08:00', '12:00'],
              ['11:00', '13:00'],
            ],
          },
        }),
      ),
    ).toMatchObject({
      code: 'overlaps',
    });
    expect((await post({ hours: { mon: [['8am', '5pm']] } })).statusCode).toBe(400);
    expect((await post({ hours: { funday: [] } })).statusCode).toBe(400);
    expect(
      firstError(
        await post({
          holidays: [
            { date: '2026-12-18', name: 'A' },
            { date: '2026-12-18', name: 'B' },
          ],
        }),
      ),
    ).toMatchObject({ code: 'duplicate_date' });
    await create({ name: 'Taken' });
    expect((await post({ name: 'Taken' })).statusCode).toBe(409);
  });

  it('is guarded like the rest of Setup', async () => {
    const a = await create();
    await f.expectGuarded('GET', '/v1/setup/business-hours', {});
    await f.expectGuarded('GET', `/v1/setup/business-hours/${a.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/business-hours', {
      payload: { name: 'G', timezone: 'UTC', hours: {} },
    });
    await f.expectGuarded('PATCH', `/v1/setup/business-hours/${a.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/business-hours/${a.id}`, {});
  });
});

describe('users’ routing settings', () => {
  it('lets users set their own availability, and administrators everything', async () => {
    const rep = f.id('rep');
    const own = await f.call('rep', 'PUT', `/v1/users/${rep}/routing`, {
      availability: {
        workingHours: { mon: [['09:00', '17:00']] },
        outOfOffice: true,
        oooUntil: '2026-10-20T00:00:00.000Z',
      },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(json(own)).toMatchObject({
      availability: { outOfOffice: true, oooUntil: '2026-10-20T00:00:00.000Z' },
      skills: [],
    });
    // Skills and capacity are the administrator's.
    expect(
      (await f.call('rep', 'PUT', `/v1/users/${rep}/routing`, { skills: ['arabic'] })).statusCode,
    ).toBe(403);
    const admin = await f.call('admin', 'PUT', `/v1/users/${rep}/routing`, {
      skills: ['arabic', 'enterprise', 'arabic'],
      capacity: [{ object: 'lead', maxOpen: 50, maxNewPerDay: 10 }],
      availability: { workingHours: null, outOfOffice: false },
    });
    expect(json(admin)).toMatchObject({
      availability: { workingHours: null, outOfOffice: false, oooUntil: null },
      skills: ['arabic', 'enterprise'],
      capacity: [{ object: 'lead', maxOpen: 50, maxNewPerDay: 10 }],
    });
    expect(json(await f.call('viewer', 'GET', `/v1/users/${rep}/routing`))).toMatchObject({
      skills: ['arabic', 'enterprise'],
    });
  });

  it('validates, denies others and keeps other workspaces out', async () => {
    const rep = f.id('rep');
    expect(
      firstError(
        await f.call('rep', 'PUT', `/v1/users/${rep}/routing`, {
          availability: { workingHours: { mon: [['17:00', '09:00']] }, outOfOffice: false },
        }),
      ),
    ).toMatchObject({ field: 'availability.workingHours.mon.0' });
    expect(
      (await f.call('admin', 'PUT', `/v1/users/${rep}/routing`, { skills: ['Not Valid'] }))
        .statusCode,
    ).toBe(400);
    expect(
      firstError(
        await f.call('admin', 'PUT', `/v1/users/${rep}/routing`, {
          capacity: [
            { object: 'lead', maxOpen: 1, maxNewPerDay: null },
            { object: 'lead', maxOpen: 2, maxNewPerDay: null },
          ],
        }),
      ),
    ).toMatchObject({ code: 'duplicate_object' });
    // A peer can neither read nor change rep's settings.
    expect((await f.call('peer', 'GET', `/v1/users/${rep}/routing`)).statusCode).toBe(403);
    expect(
      (
        await f.call('peer', 'PUT', `/v1/users/${rep}/routing`, {
          availability: { workingHours: null, outOfOffice: true },
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.call('outsider', 'GET', `/v1/users/${rep}/routing`)).statusCode).toBe(404);
    expect(
      (await f.call('outsider', 'PUT', `/v1/users/${rep}/routing`, { skills: [] })).statusCode,
    ).toBe(404);
  });
});
