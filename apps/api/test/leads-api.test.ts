import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;

beforeAll(async () => {
  f = await setupFixture('leads');
});

afterAll(async () => {
  await f.api.dispose();
});

const newLead = async (user = 'rep') =>
  String(
    json(
      await f.call(user, 'POST', '/v1/records/lead', {
        fields: { last_name: 'Chen', company: 'Pixelcraft', email: 'maya@pixelcraft.example' },
      }),
    )['id'],
  );

describe('POST /v1/leads/{id}/convert (§7.3)', () => {
  it('converts, locks the lead and undoes', async () => {
    const lead = await newLead();
    const res = await f.call('rep', 'POST', `/v1/leads/${lead}/convert`, {
      account: {},
      contact: {},
      opportunity: { fields: { close_date: '2026-12-31' } },
    });
    expect(res.statusCode).toBe(200);
    const result = json(res);
    expect(result).toMatchObject({
      accountId: expect.any(String) as unknown,
      contactId: expect.any(String) as unknown,
      opportunityId: expect.any(String) as unknown,
    });
    const account = json(
      await f.call('rep', 'GET', `/v1/records/account/${String(result['accountId'])}`),
    );
    expect(account['name']).toBe('Pixelcraft');
    const edit = await f.call('rep', 'PATCH', `/v1/records/lead/${lead}`, {
      fields: { title: 'X' },
    });
    expect(edit.statusCode).toBe(409);
    expect(
      (await f.call('rep', 'POST', `/v1/leads/${lead}/convert`, { account: {}, contact: {} }))
        .statusCode,
    ).toBe(409);

    expect((await f.call('rep', 'POST', `/v1/leads/${lead}/convert/undo`)).statusCode).toBe(204);
    expect(
      (await f.call('rep', 'GET', `/v1/records/account/${String(result['accountId'])}`)).statusCode,
    ).toBe(404);
    expect(
      json(await f.call('rep', 'GET', `/v1/records/lead/${lead}?fields=status`)),
    ).toMatchObject({ status: 'open' });
    expect((await f.call('rep', 'POST', `/v1/leads/${lead}/convert/undo`)).statusCode).toBe(404);
  });

  it('validates the request and hides other people’s leads', async () => {
    const lead = await newLead();
    const convert = (user: string, body: Json, id = lead) =>
      f.call(user, 'POST', `/v1/leads/${id}/convert`, body);
    expect((await convert('rep', { account: {} })).statusCode).toBe(400);
    expect((await convert('rep', { account: { id: 'x' }, contact: {} })).statusCode).toBe(400);
    expect((await convert('rep', { account: {}, contact: {} }, 'not-a-uuid')).statusCode).toBe(400);
    expect((await convert('peer', { account: {}, contact: {} })).statusCode).toBe(404);
    expect((await convert('outsider', { account: {}, contact: {} })).statusCode).toBe(404);
    expect((await f.call('outsider', 'POST', `/v1/leads/${lead}/convert/undo`)).statusCode).toBe(
      404,
    );
    // A required field missing on the new opportunity fails the whole conversion.
    const failed = await convert('rep', { account: {}, contact: {}, opportunity: {} });
    expect(failed.statusCode).toBe(422);
    expect(
      json(await f.call('rep', 'GET', `/v1/records/lead/${lead}?fields=status`)),
    ).toMatchObject({ status: 'open' });
  });
});

describe('/v1/leads/field-mapping', () => {
  it('shows the mapping to setup viewers and lets admins replace it, type-checked', async () => {
    const res = await f.call('viewer', 'GET', '/v1/leads/field-mapping');
    expect(res.statusCode).toBe(200);
    expect(json(res)['effective']).toContainEqual({
      leadField: 'company',
      targetObject: 'account',
      targetField: 'name',
    });
    expect(json(res)['custom']).toEqual([]);
    const put = (user: string, mappings: Json[]) =>
      f.call(user, 'PUT', '/v1/leads/field-mapping', { mappings });
    const bad = await put('admin', [
      { leadField: 'email', targetObject: 'account', targetField: 'number_of_employees' },
    ]);
    expect(bad.statusCode).toBe(400);
    expect(json(bad)['errors']).toEqual([
      expect.objectContaining({ field: 'mappings.0', code: 'incompatible_types' }) as unknown,
    ]);
    const ok = await put('admin', [
      { leadField: 'email', targetObject: 'account', targetField: 'description' },
    ]);
    expect(ok.statusCode).toBe(200);
    expect(json(ok)['custom']).toHaveLength(1);
    expect((await put('viewer', [])).statusCode).toBe(403);
    expect((await f.call('rep', 'GET', '/v1/leads/field-mapping')).statusCode).toBe(403);
    // Another workspace keeps its own (default) mapping.
    expect(json(await f.call('outsider', 'GET', '/v1/leads/field-mapping'))['custom']).toEqual([]);
    const audit = await f.inTenant(({ prisma }) =>
      prisma.setupAudit.count({ where: { action: 'lead_field_mapping.replaced' } }),
    );
    expect(audit).toBe(1);
  });
});
