import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const base = '/v1/setup/objects/lead/fields';

beforeAll(async () => {
  f = await setupFixture('fields');
});

afterAll(async () => {
  await f.api.dispose();
});

const create = (payload: Json, user = 'admin') => f.call(user, 'POST', base, payload);

describe('Setup → Object manager → fields (§5.2)', () => {
  it('lists standard fields with their settings', async () => {
    const res = await f.call('viewer', 'GET', base);
    expect(res.statusCode).toBe(200);
    const status = (json(res)['items'] as Json[]).find((x) => x['apiName'] === 'status');
    expect(status).toMatchObject({ custom: false, type: 'picklist', required: true });
    expect((status?.['picklistValues'] as Json[]).map((v) => v['apiValue'])).toContain('converted');
  });

  it('creates a custom field the admin profile can use at once, and audits it', async () => {
    const res = await create({
      name: 'region',
      label: 'Region',
      type: 'picklist',
      picklistValues: [
        { apiValue: 'emea', label: 'EMEA', isDefault: true },
        { apiValue: 'apac', label: 'APAC' },
      ],
      defaultValue: 'emea',
      access: [{ permissionSetId: f.id('set:viewSetup'), read: true, edit: false }],
    });
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      apiName: 'region__c',
      custom: true,
      type: 'picklist',
      label: 'Region',
      defaultValue: 'emea',
      version: 1,
    });
    // The field is live for records and visible in describe for the administrator.
    const lead = await f.call('admin', 'POST', '/v1/records/lead', {
      fields: { last_name: 'Chen', company: 'Pixelcraft' },
    });
    expect(json(lead)['region__c']).toBe('emea');
    const describe = json(await f.call('admin', 'GET', '/v1/objects/lead/describe'));
    expect((describe['fields'] as Json[]).map((x) => x['name'])).toContain('region__c');
    // Standard users were not granted it.
    const repDescribe = json(await f.call('rep', 'GET', '/v1/objects/lead/describe'));
    expect((repDescribe['fields'] as Json[]).map((x) => x['name'])).not.toContain('region__c');
    const audit = await f.inTenant(({ prisma }) =>
      prisma.setupAudit.count({ where: { action: 'field.created' } }),
    );
    expect(audit).toBe(1);
  });

  it('checks settings per type, names and limits', async () => {
    const code = async (payload: Json) => {
      const res = await create(payload);
      return `${String(res.statusCode)} ${String(((json(res)['errors'] as Json[] | undefined) ?? [])[0]?.['code'] ?? json(res)['code'])}`;
    };
    expect(await code({ name: 'region', label: 'Again', type: 'text' })).toBe('409 conflict');
    expect(await code({ name: 'Bad Name', label: 'X', type: 'text' })).toMatch(/^400/);
    expect(await code({ name: 'a__b', label: 'X', type: 'text' })).toMatch(/^400/);
    expect(await code({ name: 'note', label: 'X', type: 'text', length: 300 })).toBe(
      '400 invalid_length',
    );
    expect(await code({ name: 'pick', label: 'X', type: 'picklist' })).toBe('400 required');
    expect(await code({ name: 'num', label: 'X', type: 'number', precision: 4, scale: 4 })).toBe(
      '400 invalid_scale',
    );
    expect(await code({ name: 'ref', label: 'X', type: 'lookup' })).toBe('400 invalid');
    expect(await code({ name: 'ref', label: 'X', type: 'lookup', referenceTo: 'quote' })).toBe(
      '400 invalid_target',
    );
    expect(await code({ name: 'cnt', label: 'X', type: 'number', defaultValue: 'abc' })).toMatch(
      /^400 /,
    );
    expect(await code({ name: 'f', label: 'X', type: 'formula' })).toMatch(/^400/);
    // Currency fields always keep two decimals.
    const money = json(
      await create({ name: 'budget', label: 'Budget', type: 'currency', scale: 0 }),
    );
    expect(money).toMatchObject({ precision: 18, scale: 2 });
  });

  it('allows only safe changes, under an optimistic lock', async () => {
    const created = json(
      await create({ name: 'notes', label: 'Notes', type: 'text', length: 100 }),
    );
    const patch = (payload: Json, field = 'notes__c') =>
      f.call('admin', 'PATCH', `${base}/${field}`, payload);
    expect((await patch({ version: 1, length: 50 })).statusCode).toBe(400);
    expect((await patch({ version: 1, type: 'number' })).statusCode).toBe(400);
    const widened = await patch({ version: 1, type: 'long_text', label: 'Long notes' });
    expect(widened.statusCode).toBe(200);
    expect(json(widened)).toMatchObject({ type: 'long_text', label: 'Long notes', version: 2 });
    expect((await patch({ version: 1, label: 'Stale' })).statusCode).toBe(409);
    expect(created['id']).toBe(json(widened)['id']);
    // Standard fields: label, description, help and history only.
    const company = (json(await f.call('admin', 'GET', base))['items'] as Json[]).find(
      (x) => x['apiName'] === 'company',
    );
    const v = Number(company?.['version']);
    expect((await patch({ version: v, required: false }, 'company')).statusCode).toBe(400);
    const relabelled = await patch(
      { version: v, label: 'Organisation', trackHistory: true },
      'company',
    );
    expect(json(relabelled)).toMatchObject({ label: 'Organisation', trackHistory: true });
    expect((await patch({ version: 1, label: 'x' }, 'created_at')).statusCode).toBe(400);
    expect((await patch({ version: 1, label: 'x' }, 'nope__c')).statusCode).toBe(404);
  });

  it('records index requests up to the limit', async () => {
    const res = await create({ name: 'tier', label: 'Tier', type: 'text', indexed: true });
    expect(json(res)).toMatchObject({ indexed: true, indexStatus: 'PENDING' });
    for (let i = 0; i < 9; i += 1)
      expect(
        (await create({ name: `ix${String(i)}`, label: 'I', type: 'text', indexed: true }))
          .statusCode,
      ).toBe(201);
    expect(
      (await create({ name: 'ix9', label: 'I', type: 'text', indexed: true })).statusCode,
    ).toBe(409);
  });

  it('sets picklist values without ever removing one', async () => {
    const field = json(await f.call('admin', 'GET', base))['items'] as Json[];
    const region = field.find((x) => x['apiName'] === 'region__c');
    const put = (payload: Json) =>
      f.call('admin', 'PUT', `${base}/region__c/picklist-values`, payload);
    const res = await put({
      version: region?.['version'],
      values: [
        { apiValue: 'amer', label: 'Americas' },
        { apiValue: 'emea', label: 'Europe', isDefault: true },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(
      (json(res)['picklistValues'] as Json[]).map(
        (v) => `${String(v['apiValue'])}:${String(v['active'])}`,
      ),
    ).toEqual(['amer:true', 'emea:true', 'apac:false']);
    expect(
      (
        await put({
          version: json(res)['version'],
          values: [
            { apiValue: 'a', isDefault: true },
            { apiValue: 'b', isDefault: true },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await put({ version: json(res)['version'], values: [{ apiValue: 'a', category: 'OPEN' }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.call('admin', 'PUT', `${base}/company/picklist-values`, {
          version: 1,
          values: [{ apiValue: 'x' }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('deletes custom fields, not standard ones', async () => {
    expect((await f.call('admin', 'DELETE', `${base}/company`)).statusCode).toBe(400);
    expect((await f.call('admin', 'DELETE', `${base}/notes__c`)).statusCode).toBe(204);
    const names = (json(await f.call('admin', 'GET', base))['items'] as Json[]).map(
      (x) => x['apiName'],
    );
    expect(names).not.toContain('notes__c');
    // The name stays taken.
    expect((await create({ name: 'notes', label: 'Again', type: 'text' })).statusCode).toBe(409);
  });

  it('is guarded', async () => {
    await f.expectGuarded('GET', base, {});
    await f.expectGuarded('POST', base, { payload: { name: 'guard', label: 'G', type: 'text' } });
    await f.expectGuarded('PATCH', `${base}/region__c`, { payload: { version: 1 } });
    await f.expectGuarded('DELETE', `${base}/region__c`, {});
    // Another workspace has its own fields.
    const theirs = json(await f.call('outsider', 'GET', base))['items'] as Json[];
    expect(theirs.map((x) => x['apiName'])).not.toContain('region__c');
    expect((await f.call('outsider', 'DELETE', `${base}/region__c`)).statusCode).toBe(404);
  });
});
