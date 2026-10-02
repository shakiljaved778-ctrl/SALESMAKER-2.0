import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const items = (res: { body: string }) => json(res)['items'] as Json[];
const obj = (object: string, rest = '') => `/v1/setup/objects/${object}/${rest}`;

beforeAll(async () => {
  f = await setupFixture('layouts');
});

afterAll(async () => {
  await f.api.dispose();
});

describe('record types (§5.3)', () => {
  it('creates record types that narrow picklists, used by RecordService', async () => {
    const res = await f.call('admin', 'POST', obj('lead', 'record-types'), {
      apiName: 'partner',
      name: 'Partner lead',
      picklistValues: { rating: ['hot'] },
    });
    expect(res.statusCode).toBe(201);
    const rt = json(res);
    expect(rt).toMatchObject({
      apiName: 'partner',
      isDefault: false,
      picklistValues: { rating: ['hot'] },
    });
    const write = (rating: string) =>
      f.call('admin', 'POST', '/v1/records/lead', {
        fields: { last_name: 'A', company: 'B', record_type_id: rt['id'], rating },
      });
    expect((await write('hot')).statusCode).toBe(201);
    expect((await write('cold')).statusCode).toBe(400);
    expect(
      (
        await f.call('admin', 'POST', obj('lead', 'record-types'), {
          apiName: 'partner',
          name: 'Again',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call('admin', 'POST', obj('lead', 'record-types'), {
          apiName: 'x',
          name: 'X',
          picklistValues: { company: ['a'] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('switches the default and never leaves an object without one', async () => {
    const list = items(await f.call('admin', 'GET', obj('lead', 'record-types')));
    const master = list.find((r) => r['apiName'] === 'master');
    const partner = list.find((r) => r['apiName'] === 'partner');
    expect(
      (
        await f.call('admin', 'PATCH', obj('lead', `record-types/${String(master?.['id'])}`), {
          version: master?.['version'],
          active: false,
        })
      ).statusCode,
    ).toBe(400);
    const res = await f.call(
      'admin',
      'PATCH',
      obj('lead', `record-types/${String(partner?.['id'])}`),
      {
        version: partner?.['version'],
        isDefault: true,
      },
    );
    expect(json(res)).toMatchObject({ isDefault: true });
    const after = items(await f.call('admin', 'GET', obj('lead', 'record-types')));
    expect(after.filter((r) => r['isDefault']).map((r) => r['apiName'])).toEqual(['partner']);
  });
});

describe('page layouts and assignments (§5.4)', () => {
  it('validates sections and related lists, keeps one default, and assigns per profile', async () => {
    const create = (payload: Json) => f.call('admin', 'POST', obj('account', 'layouts'), payload);
    const section = (fields: string[]) => ({
      key: 'main',
      label: 'Main',
      columns: 2,
      fields: fields.map((field) => ({ field })),
    });
    expect((await create({ name: 'Bad', sections: [section(['nope'])] })).statusCode).toBe(400);
    expect((await create({ name: 'Dup', sections: [section(['name', 'name'])] })).statusCode).toBe(
      400,
    );
    expect(
      (
        await create({
          name: 'Bad related',
          sections: [section(['name'])],
          relatedLists: [{ object: 'lead', field: 'campaign_id', columns: ['last_name'] }],
        })
      ).statusCode,
    ).toBe(400);
    const res = await create({
      name: 'Sales',
      sections: [section(['name', 'phone'])],
      relatedLists: [{ object: 'contact', field: 'account_id', columns: ['last_name', 'email'] }],
    });
    expect(res.statusCode).toBe(201);
    const layout = json(res);
    const all = items(await f.call('viewer', 'GET', obj('account', 'layouts')));
    const standard = all.find((l) => l['isDefault']);
    expect(standard).toBeDefined();
    expect(
      (await f.call('admin', 'DELETE', obj('account', `layouts/${String(standard?.['id'])}`)))
        .statusCode,
    ).toBe(409);
    const promoted = await f.call(
      'admin',
      'PATCH',
      obj('account', `layouts/${String(layout['id'])}`),
      {
        version: layout['version'],
        isDefault: true,
        name: 'Sales (default)',
      },
    );
    expect(json(promoted)).toMatchObject({ isDefault: true, name: 'Sales (default)', version: 2 });
    expect(
      items(await f.call('admin', 'GET', obj('account', 'layouts'))).filter((l) => l['isDefault']),
    ).toHaveLength(1);

    const master = items(await f.call('admin', 'GET', obj('account', 'record-types')))[0];
    const put = (assignments: Json[]) =>
      f.call('admin', 'PUT', obj('account', 'layout-assignments'), { assignments });
    const assigned = await put([
      {
        profileId: f.id('profile:standard'),
        recordTypeId: master?.['id'],
        pageLayoutId: standard?.['id'],
      },
    ]);
    expect(items(assigned)).toHaveLength(1);
    expect(
      (
        await put([
          {
            profileId: f.id('profile:standard'),
            recordTypeId: master?.['id'],
            pageLayoutId: f.id('admin'),
          },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.call('admin', 'DELETE', obj('account', `layouts/${String(standard?.['id'])}`)))
        .statusCode,
    ).toBe(204);
    // Its assignments went with it.
    expect(items(await f.call('admin', 'GET', obj('account', 'layout-assignments')))).toEqual([]);
  });
});

describe('compact layouts and paths', () => {
  it('manages compact layouts of up to 7 fields', async () => {
    const res = await f.call('admin', 'POST', obj('contact', 'compact-layouts'), {
      name: 'Phone first',
      fields: ['phone', 'email', 'title'],
    });
    expect(res.statusCode).toBe(201);
    expect(
      (
        await f.call('admin', 'POST', obj('contact', 'compact-layouts'), {
          name: 'Too many',
          fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        })
      ).statusCode,
    ).toBe(400);
    const c = json(res);
    const updated = await f.call(
      'admin',
      'PATCH',
      obj('contact', `compact-layouts/${String(c['id'])}`),
      {
        version: c['version'],
        fields: ['email'],
      },
    );
    expect(json(updated)).toMatchObject({ fields: ['email'], version: 2 });
    expect(
      (await f.call('admin', 'DELETE', obj('contact', `compact-layouts/${String(c['id'])}`)))
        .statusCode,
    ).toBe(204);
  });

  it('sets path guidance per record type on a picklist', async () => {
    const rt = items(await f.call('admin', 'GET', obj('opportunity', 'record-types')))[0];
    const url = obj('opportunity', `paths/${String(rt?.['id'])}/stage`);
    const res = await f.call('admin', 'PUT', url, {
      active: true,
      steps: { qualification: { keyFields: ['amount', 'close_date'], guidance: 'Confirm budget' } },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ field: 'stage', active: true });
    expect(
      (
        await f.call('admin', 'PUT', url, {
          active: true,
          steps: { nope: { keyFields: [], guidance: '' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call('admin', 'PUT', obj('opportunity', `paths/${String(rt?.['id'])}/name`), {
          active: true,
          steps: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(items(await f.call('viewer', 'GET', obj('opportunity', 'paths')))).toHaveLength(1);
    expect((await f.call('admin', 'DELETE', url)).statusCode).toBe(204);
    expect((await f.call('admin', 'DELETE', url)).statusCode).toBe(404);
  });
});

describe('validation rules (§5.5)', () => {
  it('type checks formulas on save and RecordService enforces the rule', async () => {
    const create = (payload: Json) =>
      f.call('admin', 'POST', obj('opportunity', 'validation-rules'), payload);
    const bad = await create({ apiName: 'neg', formula: 'amount +', errorMessage: 'x' });
    expect(bad.statusCode).toBe(400);
    expect((json(bad)['errors'] as Json[])[0]).toMatchObject({ field: 'formula' });
    expect(
      (await create({ apiName: 'notbool', formula: 'amount', errorMessage: 'x' })).statusCode,
    ).toBe(400);
    expect(
      (
        await create({
          apiName: 'badfield',
          formula: 'amount < 0',
          errorMessage: 'x',
          errorField: 'nope',
        })
      ).statusCode,
    ).toBe(400);
    const res = await create({
      apiName: 'no_negative',
      formula: 'amount < 0',
      errorMessage: 'Amounts cannot be negative',
      errorField: 'amount',
    });
    expect(res.statusCode).toBe(201);
    const opp = (amount: string) =>
      f.call('admin', 'POST', '/v1/records/opportunity', {
        fields: { name: 'X', stage: 'qualification', close_date: '2026-12-01', amount },
      });
    const refused = await opp('-5');
    expect(refused.statusCode).toBe(422);
    expect(json(refused)['errors']).toEqual([
      expect.objectContaining({
        field: 'amount',
        code: 'validation_rule',
        message: 'Amounts cannot be negative',
      }) as unknown,
    ]);
    const rule = json(res);
    await f.call('admin', 'PATCH', obj('opportunity', `validation-rules/${String(rule['id'])}`), {
      version: rule['version'],
      active: false,
    });
    expect((await opp('-5')).statusCode).toBe(201);
    expect(
      (
        await f.call(
          'admin',
          'DELETE',
          obj('opportunity', `validation-rules/${String(rule['id'])}`),
        )
      ).statusCode,
    ).toBe(204);
  });
});

describe('guards', () => {
  it('reads need view_setup, changes customize_application; other workspaces see nothing', async () => {
    for (const segment of [
      'record-types',
      'layouts',
      'compact-layouts',
      'paths',
      'validation-rules',
      'layout-assignments',
    ])
      await f.expectGuarded('GET', obj('lead', segment), {});
    await f.expectGuarded('POST', obj('lead', 'validation-rules'), {
      payload: { apiName: 'g', formula: 'false', errorMessage: 'x' },
    });
    const rule = json(
      await f.call('admin', 'POST', obj('lead', 'validation-rules'), {
        apiName: 'mine',
        formula: 'false',
        errorMessage: 'x',
      }),
    );
    await f.expectGuarded('DELETE', obj('lead', `validation-rules/${String(rule['id'])}`), {});
    expect(items(await f.call('outsider', 'GET', obj('lead', 'validation-rules')))).toEqual([]);
  });
});

describe('formula check (§5.5)', () => {
  const check = (user: string, body: Record<string, unknown>, object = 'lead') =>
    f.call(user, 'POST', obj(object, 'formula/check'), body);

  it('returns the type of a valid formula, or the first error with where it is', async () => {
    const ok = await check('viewer', { formula: 'ISBLANK(company)', expected: 'Boolean' });
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toEqual({ ok: true, type: 'Boolean', error: null });

    const unknown = json(await check('viewer', { formula: 'ISBLANK(no_such_field)' }));
    expect(unknown).toMatchObject({ ok: false, type: null, error: { code: 'unknown_field' } });
    const error = unknown['error'] as Record<string, number>;
    expect(error['start']).toBe(8);
    expect(error['end']).toBeGreaterThan(8);

    const wrong = json(await check('viewer', { formula: 'company', expected: 'Boolean' }));
    expect(wrong).toMatchObject({ error: { code: 'wrong_result_type' } });
  });

  it('needs view_setup and an object in this workspace', async () => {
    expect((await check('rep', { formula: 'TRUE' })).statusCode).toBe(403);
    expect((await check('admin', { formula: 'TRUE' }, 'widget')).statusCode).toBe(404);
    expect((await check('admin', { formula: 'x'.repeat(5001) })).statusCode).toBe(400);
  });
});
