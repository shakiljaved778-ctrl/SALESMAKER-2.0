import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const items = (res: { body: string }) => json(res)['items'] as Json[];
const base = '/v1/objects/lead/list-views';

let groupId = '';
const views = new Map<string, string>();

beforeAll(async () => {
  f = await setupFixture('list-views');
  // A public group with peer in it, before anyone's principals are cached.
  groupId = await f.inTenant(async (tx) => {
    const group = await tx.prisma.publicGroup.create({
      data: { tenantId: tx.context.tenantId, name: 'Doha team' },
    });
    await tx.prisma.groupMember.create({
      data: {
        tenantId: tx.context.tenantId,
        groupId: group.id,
        memberType: 'USER',
        userId: f.id('peer'),
      },
    });
    return group.id;
  });
  for (const [name, company, owner] of [
    ['Chen', 'Pixelcraft', 'rep'],
    ['Haddad', 'Aurelia Bank', 'rep'],
    ['Nair', 'Aurelia Bank', 'peer'],
  ] as const) {
    const res = await f.call(owner, 'POST', '/v1/records/lead', {
      fields: { last_name: name, company },
    });
    expect(res.statusCode).toBe(201);
  }
});

afterAll(async () => {
  await f.api.dispose();
});

describe('list views (§5.6)', () => {
  it('starts every object with All, Mine and Recent, visible to everyone', async () => {
    const res = await f.call('rep', 'GET', base);
    expect(res.statusCode).toBe(200);
    const keys = items(res).map((v) => v['systemKey']);
    expect(keys.slice(0, 3)).toEqual(['all', 'mine', 'recent']);
    expect(items(res)[0]).toMatchObject({ visibility: 'ALL', editable: false });
    expect(json(res)['pinnedId']).toBeNull();
    for (const v of items(res)) views.set(String(v['systemKey']), String(v['id']));
    const admin = items(await f.call('admin', 'GET', base));
    expect(admin[0]).toMatchObject({ editable: true });
  });

  it('runs a view as the viewer, with sharing, quick filters, search and a count', async () => {
    const mine = await f.call('rep', 'POST', `${base}/${views.get('mine') ?? ''}/results`, {
      count: true,
    });
    expect(mine.statusCode).toBe(200);
    expect(items(mine).map((r) => r['last_name'])).toEqual(['Chen', 'Haddad']);
    expect(json(mine)['count']).toEqual({ count: 2, capped: false });

    const all = `${base}/${views.get('all') ?? ''}/results`;
    const filtered = await f.call('admin', 'POST', all, {
      where: { field: 'company', op: 'eq', value: 'Aurelia Bank' },
      sort: [{ field: 'last_name', direction: 'desc' }],
      count: true,
    });
    expect(items(filtered).map((r) => r['last_name'])).toEqual(['Nair', 'Haddad']);
    const searched = await f.call('admin', 'POST', all, { search: 'had' });
    expect(items(searched).map((r) => r['last_name'])).toEqual(['Haddad']);
    expect(json(searched)['count']).toBeUndefined();

    const paged = await f.call('admin', 'POST', all, { limit: 1 });
    expect(items(paged)).toHaveLength(1);
    const next = await f.call('admin', 'POST', all, {
      limit: 1,
      cursor: json(paged)['nextCursor'],
    });
    expect(items(next)[0]?.['id']).not.toBe(items(paged)[0]?.['id']);
  });

  it('saves private views for their owner only', async () => {
    const res = await f.call('rep', 'POST', base, {
      name: 'My Aurelia leads',
      filter: { field: 'company', op: 'eq', value: 'Aurelia Bank' },
      columns: ['last_name', 'company', 'status'],
      sort: [{ field: 'last_name', direction: 'asc' }],
    });
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({ visibility: 'PRIVATE', editable: true, version: 1 });
    views.set('private', String(json(res)['id']));
    const peerSees = items(await f.call('peer', 'GET', base)).map((v) => v['id']);
    expect(peerSees).not.toContain(views.get('private'));
    const run = await f.call('peer', 'POST', `${base}/${views.get('private') ?? ''}/results`, {});
    expect(run.statusCode).toBe(404);
  });

  it('refuses unknown fields and bad filters', async () => {
    const bad = (body: Json) => f.call('rep', 'POST', base, { name: 'Bad', ...body });
    expect((await bad({ columns: ['no_such_field'] })).statusCode).toBe(400);
    expect(
      (await bad({ columns: ['last_name'], filter: { field: 'company', op: 'nope' } })).statusCode,
    ).toBe(400);
    expect(
      (await bad({ columns: ['last_name'], sort: [{ field: 'zzz', direction: 'asc' }] }))
        .statusCode,
    ).toBe(400);
  });

  it('shares views with groups or everyone only with customize_application, audited', async () => {
    const shared = {
      name: 'Doha pipeline',
      visibility: 'GROUPS',
      groupIds: [groupId],
      columns: ['last_name', 'company'],
    };
    expect((await f.call('rep', 'POST', base, shared)).statusCode).toBe(403);
    expect((await f.call('admin', 'POST', base, { ...shared, groupIds: [] })).statusCode).toBe(400);
    const res = await f.call('admin', 'POST', base, shared);
    expect(res.statusCode).toBe(201);
    const id = String(json(res)['id']);
    views.set('group', id);
    expect(items(await f.call('peer', 'GET', base)).map((v) => v['id'])).toContain(id);
    expect(items(await f.call('rep', 'GET', base)).map((v) => v['id'])).not.toContain(id);
    const peerView = items(await f.call('peer', 'GET', base)).find((v) => v['id'] === id);
    expect(peerView).toMatchObject({ editable: false });
    expect((await f.call('peer', 'PATCH', `${base}/${id}`, { name: 'Mine now' })).statusCode).toBe(
      403,
    );
    const logged = await f.inTenant((tx) =>
      tx.prisma.setupAudit.findFirst({ where: { action: 'list_view.created', entityId: id } }),
    );
    expect(logged).not.toBeNull();
  });

  it('updates with an optimistic lock and clears a filter', async () => {
    const id = views.get('private') ?? '';
    const stale = await f.call('rep', 'PATCH', `${base}/${id}`, { name: 'Renamed' });
    expect(stale.statusCode).toBe(200);
    expect(json(stale)).toMatchObject({ name: 'Renamed', version: 2 });
    const conflict = await f.api.app.inject({
      method: 'PATCH',
      url: `${base}/${id}`,
      headers: {
        authorization: `Bearer ${await f.api.tokenFor(f.tenantId, f.id('rep'))}`,
        'if-match': '1',
      },
      payload: { name: 'Again' },
    });
    expect(conflict.statusCode).toBe(409);
    const cleared = await f.call('rep', 'PATCH', `${base}/${id}`, { filter: null });
    expect(json(cleared)).toMatchObject({ filter: null, version: 3 });
    expect((await f.call('rep', 'PATCH', `${base}/${id}`, { visibility: 'ALL' })).statusCode).toBe(
      403,
    );
  });

  it('keeps the views every object starts with', async () => {
    const all = views.get('all') ?? '';
    expect((await f.call('admin', 'DELETE', `${base}/${all}`)).statusCode).toBe(409);
    expect(
      (await f.call('admin', 'PATCH', `${base}/${all}`, { visibility: 'PRIVATE' })).statusCode,
    ).toBe(400);
    expect((await f.call('rep', 'DELETE', `${base}/${all}`)).statusCode).toBe(403);
  });

  it('pins a default view per user', async () => {
    const id = views.get('private') ?? '';
    expect((await f.call('rep', 'PUT', `${base}/${id}/pin`)).statusCode).toBe(204);
    expect(json(await f.call('rep', 'GET', base))['pinnedId']).toBe(id);
    expect(json(await f.call('peer', 'GET', base))['pinnedId']).toBeNull();
    expect((await f.call('peer', 'PUT', `${base}/${id}/pin`)).statusCode).toBe(404);
  });

  it('deletes a saved view', async () => {
    const id = views.get('private') ?? '';
    expect((await f.call('peer', 'DELETE', `${base}/${id}`)).statusCode).toBe(404);
    expect((await f.call('rep', 'DELETE', `${base}/${id}`)).statusCode).toBe(204);
    expect((await f.call('rep', 'POST', `${base}/${id}/results`, {})).statusCode).toBe(404);
    expect(json(await f.call('rep', 'GET', base))['pinnedId']).toBeNull();
  });

  it('never shows another workspace’s views (404, never 403)', async () => {
    const id = views.get('all') ?? '';
    expect((await f.call('outsider', 'POST', `${base}/${id}/results`, {})).statusCode).toBe(404);
    expect((await f.call('outsider', 'PATCH', `${base}/${id}`, { name: 'x' })).statusCode).toBe(
      404,
    );
    expect(
      (await f.call('outsider', 'DELETE', `${base}/${views.get('group') ?? ''}`)).statusCode,
    ).toBe(404);
    const theirs = items(await f.call('outsider', 'GET', base)).map((v) => v['id']);
    expect(theirs).not.toContain(id);
  });

  it('validates the request', async () => {
    expect((await f.call('rep', 'POST', base, { name: '', columns: [] })).statusCode).toBe(400);
    expect((await f.call('rep', 'GET', '/v1/objects/widget/list-views')).statusCode).toBe(404);
    expect(
      (await f.call('rep', 'POST', `${base}/${views.get('all') ?? ''}/results`, { limit: 0 }))
        .statusCode,
    ).toBe(400);
  });
});

describe('field-level security in list views (§6.5)', () => {
  it('leaves a hidden column out of a shared view, ignores it in sorts and refuses it in filters', async () => {
    const created = await f.call('admin', 'POST', base, {
      name: 'With titles',
      visibility: 'ALL',
      columns: ['last_name', 'company', 'title'],
    });
    expect(created.statusCode).toBe(201);
    const results = `${base}/${String(json(created)['id'])}/results`;
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
    const run = await f.call('rep', 'POST', results, {});
    expect(run.statusCode).toBe(200);
    expect(json(run)['columns']).toEqual(['last_name', 'company']);
    for (const row of items(run)) expect(row).not.toHaveProperty('title');
    // The administrator still sees the column.
    expect(json(await f.call('admin', 'POST', results, {}))['columns']).toContain('title');
    // A sort on a hidden field is dropped (the order would reveal its values); the default
    // order comes back.
    const sorted = await f.call('rep', 'POST', results, {
      sort: [{ field: 'title', direction: 'asc' }],
    });
    expect(sorted.statusCode).toBe(200);
    expect(items(sorted).map((r) => r['id'])).toEqual(items(run).map((r) => r['id']));
    // A filter on it is refused as an unknown field, as if it did not exist.
    const filtered = await f.call('rep', 'POST', results, {
      where: { field: 'title', op: 'eq', value: 'CTO' },
    });
    expect(filtered.statusCode).toBe(400);
  });
});
