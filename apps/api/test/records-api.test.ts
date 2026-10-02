import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const items = (res: { body: string }) => json(res)['items'] as Json[];

beforeAll(async () => {
  f = await setupFixture('records');
});

afterAll(async () => {
  await f.api.dispose();
});

/** Like f.call, with extra headers. */
async function as(
  user: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Json,
  headers: Record<string, string> = {},
) {
  const tenant = user === 'outsider' ? f.otherTenant : f.tenantId;
  return f.api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await f.api.tokenFor(tenant, f.id(user))}`, ...headers },
    ...(payload ? { payload } : {}),
  });
}

const lead = (extra: Json = {}) => ({
  fields: { last_name: 'Chen', company: 'Pixelcraft', ...extra },
});

describe('objects and describe (§10.1)', () => {
  it('lists the objects the caller can read, with what they may do', async () => {
    const res = await as('rep', 'GET', '/v1/objects');
    expect(res.statusCode).toBe(200);
    const byName = new Map(items(res).map((o) => [o['name'], o]));
    expect(byName.get('lead')).toMatchObject({
      access: { read: true, create: true, edit: true, delete: true },
    });
    expect(byName.get('campaign')).toMatchObject({ access: { read: true, create: false } });
  });

  it('describes an object’s visible fields, and nothing for unknown objects', async () => {
    const res = await as('rep', 'GET', '/v1/objects/lead/describe');
    expect(res.statusCode).toBe(200);
    const fields = (json(res)['fields'] as Json[]).map((x) => x['name']);
    expect(fields).toEqual(expect.arrayContaining(['last_name', 'company', 'status']) as unknown);
    expect((await as('rep', 'GET', '/v1/objects/widget/describe')).statusCode).toBe(404);
    expect((await as('rep', 'GET', '/v1/objects/Not-An-Object/describe')).statusCode).toBe(400);
  });
});

describe('records CRUD', () => {
  let id = '';

  it('creates a record once per Idempotency-Key', async () => {
    const key = { 'idempotency-key': 'create-lead-0001' };
    const first = await as('rep', 'POST', '/v1/records/lead', lead(), key);
    expect(first.statusCode).toBe(201);
    const body = json(first);
    expect(body).toMatchObject({
      version: 1,
      last_name: 'Chen',
      company: 'Pixelcraft',
      status: 'open',
    });
    expect(body['owner_id']).toMatchObject({ id: f.id('rep'), object: 'user' });
    id = String(body['id']);
    const replay = await as('rep', 'POST', '/v1/records/lead', lead(), key);
    expect(replay.statusCode).toBe(201);
    expect(json(replay)['id']).toBe(id);
    const reused = await as('rep', 'POST', '/v1/records/lead', lead({ last_name: 'Other' }), key);
    expect(reused.statusCode).toBe(422);
    expect(json(reused)['code']).toBe('idempotency_key_reused');
    // Keys are per caller: the same key from someone else is a new request.
    expect((await as('peer', 'POST', '/v1/records/lead', lead(), key)).statusCode).toBe(201);
    const count = await f.inTenant(
      ({ prisma }) =>
        prisma.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM lead WHERE company = 'Pixelcraft'`,
    );
    expect(count[0]?.n).toBe(2);
  });

  it('refuses invalid writes with field-keyed errors', async () => {
    const missing = await as('rep', 'POST', '/v1/records/lead', { fields: { company: 'X' } });
    expect(missing.statusCode).toBe(422);
    expect(json(missing)['errors']).toEqual([
      expect.objectContaining({ field: 'last_name', code: 'required' }) as unknown,
    ]);
    expect((await as('rep', 'POST', '/v1/records/lead', lead({ nope: 1 }))).statusCode).toBe(400);
    expect((await as('rep', 'POST', '/v1/records/lead', { last_name: 'X' })).statusCode).toBe(400);
    expect((await as('rep', 'POST', '/v1/records/widget', lead())).statusCode).toBe(404);
    // Campaigns are read-only to Standard Users.
    expect(
      (await as('rep', 'POST', '/v1/records/campaign', { fields: { name: 'Spring' } })).statusCode,
    ).toBe(403);
  });

  it('reads a record the caller can see, with the fields asked for', async () => {
    const res = await as('rep', 'GET', `/v1/records/lead/${id}?fields=last_name,company`);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ id, version: 1, last_name: 'Chen', company: 'Pixelcraft' });
    expect((await as('peer', 'GET', `/v1/records/lead/${id}`)).statusCode).toBe(404);
    expect((await as('rep', 'GET', '/v1/records/lead/not-a-uuid')).statusCode).toBe(400);
    expect((await as('rep', 'GET', `/v1/records/lead/${id}?fields=secret_field`)).statusCode).toBe(
      400,
    );
  });

  it('updates with If-Match and reports conflicts', async () => {
    const ok = await as(
      'rep',
      'PATCH',
      `/v1/records/lead/${id}`,
      { fields: { title: 'CTO' } },
      {
        'if-match': '"1"',
      },
    );
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toMatchObject({ version: 2, title: 'CTO' });
    const stale = await as(
      'rep',
      'PATCH',
      `/v1/records/lead/${id}`,
      { fields: { title: 'CEO' } },
      {
        'if-match': '1',
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(json(stale)['code']).toBe('version_conflict');
    expect(
      (await as('rep', 'PATCH', `/v1/records/lead/${id}`, { fields: {} }, { 'if-match': 'x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await as('peer', 'PATCH', `/v1/records/lead/${id}`, { fields: { title: 'X' } })).statusCode,
    ).toBe(404);
  });

  it('lists with filters, sort and cursor pages', async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma'])
      await as('rep', 'POST', '/v1/records/lead', lead({ last_name: name, company: 'Listco' }));
    const page1 = await as(
      'rep',
      'GET',
      '/v1/records/lead?fields=last_name&filter[company]=Listco&sort=-last_name&limit=2',
    );
    expect(page1.statusCode).toBe(200);
    expect(items(page1).map((r) => r['last_name'])).toEqual(['Gamma', 'Beta']);
    const cursor = String(json(page1)['nextCursor']);
    const page2 = await as(
      'rep',
      'GET',
      `/v1/records/lead?fields=last_name&filter[company]=Listco&sort=-last_name&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(items(page2).map((r) => r['last_name'])).toEqual(['Alpha']);
    expect(json(page2)['nextCursor']).toBeNull();
    const inList = await as(
      'rep',
      'GET',
      '/v1/records/lead?fields=last_name&filter[last_name][in]=Alpha,Gamma&sort=last_name',
    );
    expect(items(inList).map((r) => r['last_name'])).toEqual(['Alpha', 'Gamma']);
    // The peer sees none of the rep's leads.
    expect(items(await as('peer', 'GET', '/v1/records/lead?filter[company]=Listco'))).toEqual([]);
    expect((await as('rep', 'GET', '/v1/records/lead?filter[nope]=1')).statusCode).toBe(400);
    expect((await as('rep', 'GET', '/v1/records/lead?filter[company][near]=1')).statusCode).toBe(
      400,
    );
    expect((await as('rep', 'GET', '/v1/records/lead?limit=500')).statusCode).toBe(400);
  });

  it('runs SMQ queries', async () => {
    const res = await as('rep', 'POST', '/v1/query', {
      object: 'lead',
      fields: ['last_name'],
      where: { field: 'company', op: 'eq', value: 'Listco' },
      orderBy: [{ field: 'last_name', direction: 'asc' }],
    });
    expect(res.statusCode).toBe(200);
    expect(items(res).map((r) => r['last_name'])).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect((await as('rep', 'POST', '/v1/query', { object: 'lead', fields: [] })).statusCode).toBe(
      400,
    );
    expect(
      (await as('rep', 'POST', '/v1/query', { object: 'widget', fields: ['name'] })).statusCode,
    ).toBe(404);
  });

  it('deletes to the recycle bin and restores', async () => {
    expect((await as('peer', 'DELETE', `/v1/records/lead/${id}`)).statusCode).toBe(404);
    expect((await as('rep', 'DELETE', `/v1/records/lead/${id}`)).statusCode).toBe(204);
    expect((await as('rep', 'GET', `/v1/records/lead/${id}`)).statusCode).toBe(404);
    const bin = items(await as('rep', 'GET', '/v1/recycle-bin'));
    expect(bin).toEqual([
      expect.objectContaining({ object: 'lead', recordId: id, name: 'Chen' }) as unknown,
    ]);
    expect(items(await as('peer', 'GET', '/v1/recycle-bin'))).toEqual([]);
    expect(items(await as('admin', 'GET', '/v1/recycle-bin'))).toHaveLength(1);
    expect((await as('peer', 'POST', `/v1/records/lead/${id}/restore`)).statusCode).toBe(404);
    const restored = await as('rep', 'POST', `/v1/records/lead/${id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(json(restored)).toEqual({ restored: 1 });
    expect((await as('rep', 'GET', `/v1/records/lead/${id}`)).statusCode).toBe(200);
  });
});

describe('money, upsert and teams', () => {
  it('reads and writes money as Money', async () => {
    const res = await as('rep', 'POST', '/v1/records/opportunity', {
      fields: {
        name: 'Big deal',
        stage: 'qualification',
        close_date: '2026-12-01',
        amount: { amount: '1000.00', currency: 'USD' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(json(res)['amount']).toEqual({ amount: '1000.00', currency: 'USD' });
    const mismatch = await as('rep', 'POST', '/v1/records/opportunity', {
      fields: { name: 'X', amount: { amount: '1.00', currency: 'EUR' } },
      currencyCode: 'USD',
    });
    expect(mismatch.statusCode).toBe(400);
    expect(json(mismatch)['errors']).toEqual([
      expect.objectContaining({ field: 'amount', code: 'currency_mismatch' }) as unknown,
    ]);
  });

  it('upserts by external id', async () => {
    const url = '/v1/records/account/external/ERP-0042';
    const created = await as('rep', 'PUT', url, { fields: { name: 'Initech' } });
    expect(created.statusCode).toBe(201);
    const updated = await as('rep', 'PUT', url, { fields: { name: 'Initech Ltd' } });
    expect(updated.statusCode).toBe(200);
    expect(json(updated)).toMatchObject({
      id: json(created)['id'],
      name: 'Initech Ltd',
      external_id: 'ERP-0042',
      version: 2,
    });
    expect(
      (await as('rep', 'PUT', url, { fields: { name: 'X', external_id: 'OTHER' } })).statusCode,
    ).toBe(400);
    // Someone who cannot see the record cannot update it either.
    expect((await as('peer', 'PUT', url, { fields: { name: 'Hijack' } })).statusCode).toBe(404);
  });

  it('manages account teams', async () => {
    const account = String(
      json(await as('rep', 'POST', '/v1/records/account', { fields: { name: 'Teamco' } }))['id'],
    );
    expect((await as('peer', 'GET', `/v1/records/account/${account}`)).statusCode).toBe(404);
    const put = await as('rep', 'PUT', `/v1/records/account/${account}/team/${f.id('peer')}`, {
      access: 1,
      role: 'Advisor',
    });
    expect(put.statusCode).toBe(200);
    expect(items(put)).toEqual([
      expect.objectContaining({ userId: f.id('peer'), access: 1, role: 'Advisor' }) as unknown,
    ]);
    expect((await as('peer', 'GET', `/v1/records/account/${account}`)).statusCode).toBe(200);
    expect(
      (
        await as('peer', 'PUT', `/v1/records/account/${account}/team/${f.id('viewer')}`, {
          access: 1,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await as('rep', 'DELETE', `/v1/records/account/${account}/team/${f.id('peer')}`)).statusCode,
    ).toBe(204);
    expect((await as('peer', 'GET', `/v1/records/account/${account}`)).statusCode).toBe(404);
    expect((await as('rep', 'GET', `/v1/records/lead/${account}/team`)).statusCode).toBe(400);
  });
});

describe('mass actions and jobs', () => {
  it('needs the action’s permission and follows the job', async () => {
    const body = {
      where: { field: 'company', op: 'eq', value: 'Listco' },
      action: { kind: 'update', fields: { rating: 'hot' } },
    };
    expect((await as('rep', 'POST', '/v1/records/lead/mass', body)).statusCode).toBe(403);
    const preview = await as('admin', 'POST', '/v1/records/lead/mass/preview', body);
    expect(json(preview)).toEqual({ count: 3, tooMany: false });
    const started = await as('admin', 'POST', '/v1/records/lead/mass', body);
    expect(started.statusCode).toBe(202);
    const job = json(started);
    expect(job).toMatchObject({ kind: 'mass_update', status: 'QUEUED', total: 3 });
    const read = await as('admin', 'GET', `/v1/jobs/${String(job['id'])}`);
    expect(json(read)).toMatchObject({ id: job['id'], status: 'QUEUED' });
    expect((await as('rep', 'GET', `/v1/jobs/${String(job['id'])}`)).statusCode).toBe(404);
    expect((await as('outsider', 'GET', `/v1/jobs/${String(job['id'])}`)).statusCode).toBe(404);
  });
});

describe('field-level security (§6.5)', () => {
  it('strips hidden fields from reads and refuses them in writes and filters', async () => {
    await f.inTenant(async ({ prisma }) => {
      const profile = await prisma.profile.findFirstOrThrow({
        where: { id: f.id('profile:standard') },
      });
      await prisma.fieldPermission.updateMany({
        where: { permissionSetId: profile.permissionSetId, object: 'lead', field: 'title' },
        data: { canRead: false, canEdit: false },
      });
      await prisma.tenantSettings.update({
        where: { tenantId: f.tenantId },
        data: { permVersion: { increment: 1 } },
      });
    });
    const created = json(await as('rep', 'POST', '/v1/records/lead', lead({ last_name: 'Fls' })));
    expect(created).not.toHaveProperty('title');
    const id = String(created['id']);
    expect(json(await as('rep', 'GET', `/v1/records/lead/${id}`))).not.toHaveProperty('title');
    // Asking for it explicitly returns the record without it (as if the field did not exist).
    const asked = await as('rep', 'GET', `/v1/records/lead/${id}?fields=last_name,title`);
    expect(json(asked)).toEqual({ id, version: 1, last_name: 'Fls' });
    expect(
      (await as('rep', 'PATCH', `/v1/records/lead/${id}`, { fields: { title: 'X' } })).statusCode,
    ).toBe(403);
    const filtered = await as('rep', 'GET', '/v1/records/lead?filter[title]=CTO');
    expect(filtered.statusCode).toBe(400);
    expect(json(filtered)['errors']).toEqual([
      expect.objectContaining({ code: 'unknown_field' }) as unknown,
    ]);
    const describe = json(await as('rep', 'GET', '/v1/objects/lead/describe'));
    expect((describe['fields'] as Json[]).map((x) => x['name'])).not.toContain('title');
  });
});

describe('another workspace (cross-tenant denial)', () => {
  const objects: [string, Json][] = [
    ['lead', { last_name: 'Tenant', company: 'A' }],
    ['account', { name: 'Tenant A' }],
    ['contact', { last_name: 'Tenant' }],
    ['opportunity', { name: 'Tenant A', stage: 'qualification', close_date: '2026-12-01' }],
    ['campaign', { name: 'Tenant A' }],
  ];
  for (const [object, fields] of objects)
    it(`never reaches ${object} records of another workspace`, async () => {
      const created = await as('admin', 'POST', `/v1/records/${object}`, { fields });
      expect(created.statusCode).toBe(201);
      const url = `/v1/records/${object}/${String(json(created)['id'])}`;
      expect((await as('outsider', 'GET', url)).statusCode).toBe(404);
      expect((await as('outsider', 'PATCH', url, { fields: {} })).statusCode).toBe(404);
      expect((await as('outsider', 'DELETE', url)).statusCode).toBe(404);
      expect((await as('outsider', 'POST', `${url}/restore`)).statusCode).toBe(404);
      expect(items(await as('outsider', 'GET', `/v1/records/${object}`))).toEqual([]);
      expect((await as('admin', 'GET', url)).statusCode).toBe(200);
    });

  it('needs a signed-in caller', async () => {
    expect((await f.api.app.inject({ method: 'GET', url: '/v1/records/lead' })).statusCode).toBe(
      401,
    );
  });
});
