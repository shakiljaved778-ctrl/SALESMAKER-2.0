import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const fieldsUrl = '/v1/setup/objects/lead/fields';

let account = '';
let lead = '';

/** Turn history tracking on for a lead field (Setup). */
async function track(field: string) {
  const list = json(await f.call('admin', 'GET', fieldsUrl))['items'] as Json[];
  const current = list.find((x) => x['apiName'] === field) ?? {};
  const res = await f.call('admin', 'PATCH', `${fieldsUrl}/${field}`, {
    version: current['version'],
    trackHistory: true,
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  f = await setupFixture('record-page');
  // A custom field only the System Administrator may read (new fields are granted to it alone).
  const secret = await f.call('admin', 'POST', fieldsUrl, {
    name: 'secret',
    label: 'Secret',
    type: 'text',
    length: 80,
    trackHistory: true,
  });
  expect(secret.statusCode, secret.body).toBe(201);
  await track('status');
  account = String(
    json(await f.call('rep', 'POST', '/v1/records/account', { fields: { name: 'Aurelia Bank' } }))[
      'id'
    ],
  );
  lead = String(
    json(
      await f.call('rep', 'POST', '/v1/records/lead', {
        fields: { first_name: 'Amira', last_name: 'Chen', company: 'Aurelia Bank' },
      }),
    )['id'],
  );
});

afterAll(async () => {
  await f.api.dispose();
});

describe('record page (§9.11 T2)', () => {
  it('returns the record with its layout, compact fields and path', async () => {
    const res = await f.call('rep', 'GET', `/v1/records/lead/${lead}/page`);
    expect(res.statusCode).toBe(200);
    const page = json(res);
    expect(page['record']).toMatchObject({ id: lead, first_name: 'Amira', last_name: 'Chen' });
    const layout = page['layout'] as { sections: Json[] };
    expect(layout.sections.length).toBeGreaterThan(0);
    expect(layout.sections[0]).toMatchObject({ key: 'details', label: 'Details', columns: 2 });
    const shown = layout.sections.flatMap((s) => (s['fields'] as Json[]).map((x) => x['field']));
    expect(shown).toContain('company');
    // FLS: the rep cannot read the custom field, so it is nowhere on their page.
    expect(shown).not.toContain('secret__c');
    expect(page['compactFields']).toEqual(expect.arrayContaining(['company']) as unknown);
    expect(Object.keys(page['record'] as Json)).not.toContain('secret__c');
  });

  it('derives related lists from lookups when the layout has none', async () => {
    const page = json(await f.call('rep', 'GET', `/v1/records/account/${account}/page`));
    const related = (page['layout'] as { relatedLists: Json[] }).relatedLists;
    const contacts = related.find((r) => r['object'] === 'contact');
    expect(contacts).toMatchObject({ field: 'account_id', label: 'Contacts', canCreate: true });
    expect(contacts?.['columns']).toEqual(expect.arrayContaining(['last_name']) as unknown);
    expect(related.map((r) => r['object'])).toContain('opportunity');
    // Bookkeeping lookups (converted_account_id) never make a list.
    expect(related.some((r) => String(r['field']).startsWith('converted_'))).toBe(false);
  });

  it('shows the path for the record type, with its stages in order', async () => {
    expect(json(await f.call('rep', 'GET', `/v1/records/lead/${lead}/page`))['path']).toBeNull();
    const types = json(await f.call('admin', 'GET', '/v1/setup/objects/lead/record-types'))[
      'items'
    ] as Json[];
    const rt = String(types[0]?.['id']);
    const put = await f.call('admin', 'PUT', `/v1/setup/objects/lead/paths/${rt}/status`, {
      active: true,
      steps: { working: { keyFields: ['company', 'secret__c'], guidance: 'Call within a day' } },
    });
    expect(put.statusCode).toBe(200);
    const page = json(await f.call('rep', 'GET', `/v1/records/lead/${lead}/page`));
    const path = page['path'] as { field: string; stages: Json[] };
    expect(path.field).toBe('status');
    expect(path.stages.map((s) => s['value'])).toEqual([
      'open',
      'working',
      'nurture',
      'qualified',
      'unqualified',
      'converted',
    ]);
    // Key fields the rep cannot read are dropped from the path, like everywhere else.
    expect(path.stages[1]).toMatchObject({
      keyFields: ['company'],
      guidance: 'Call within a day',
    });
    expect(page['record']).toMatchObject({ status: 'open' });
  });

  it('pages field history newest first, masked by FLS', async () => {
    for (const status of ['working', 'nurture']) {
      const current = json(await f.call('rep', 'GET', `/v1/records/lead/${lead}`));
      const res = await f.call('rep', 'PATCH', `/v1/records/lead/${lead}`, {
        fields: { status },
      });
      expect(res.statusCode, String(current['version'])).toBe(200);
    }
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/records/lead/${lead}`, {
          fields: { secret__c: 'top' },
        })
      ).statusCode,
    ).toBe(200);

    const admin = json(await f.call('admin', 'GET', `/v1/records/lead/${lead}/history`));
    const adminFields = (admin['items'] as Json[]).map((x) => x['field']);
    expect(adminFields).toEqual(['secret__c', 'status', 'status']);

    const rep = await f.call('rep', 'GET', `/v1/records/lead/${lead}/history?limit=1`);
    expect(rep.statusCode).toBe(200);
    const first = json(rep);
    expect(first['items']).toEqual([
      expect.objectContaining({
        field: 'status',
        oldValue: 'working',
        newValue: 'nurture',
        changedBy: { id: f.id('rep'), name: expect.any(String) as unknown },
      }),
    ]);
    const next = json(
      await f.call(
        'rep',
        'GET',
        `/v1/records/lead/${lead}/history?limit=1&cursor=${encodeURIComponent(String(first['nextCursor']))}`,
      ),
    );
    expect(next['items']).toEqual([expect.objectContaining({ oldValue: 'open' })]);
    expect(next['nextCursor']).toBeNull();
  });

  it('is 404 for records the caller cannot see and for other workspaces', async () => {
    const mine = json(
      await f.call('peer', 'POST', '/v1/records/lead', {
        fields: { last_name: 'Private', company: 'Elsewhere' },
      }),
    );
    const id = String(mine['id']);
    // Leads are private by default (OWD): the rep cannot see the peer's lead.
    expect((await f.call('rep', 'GET', `/v1/records/lead/${id}/page`)).statusCode).toBe(404);
    expect((await f.call('rep', 'GET', `/v1/records/lead/${id}/history`)).statusCode).toBe(404);
    expect((await f.call('outsider', 'GET', `/v1/records/lead/${lead}/page`)).statusCode).toBe(404);
    expect((await f.call('outsider', 'GET', `/v1/records/lead/${lead}/history`)).statusCode).toBe(
      404,
    );
  });

  it('validates the request', async () => {
    expect((await f.call('rep', 'GET', '/v1/records/lead/not-a-uuid/page')).statusCode).toBe(400);
    expect(
      (await f.call('rep', 'GET', `/v1/records/lead/${lead}/history?limit=0`)).statusCode,
    ).toBe(400);
    expect(
      (await f.call('rep', 'GET', `/v1/records/lead/${lead}/history?cursor=garbage`)).statusCode,
    ).toBe(400);
  });
});
