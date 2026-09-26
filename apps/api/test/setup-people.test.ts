import { visibility } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PermissionService } from '../src/permissions/permission.service.js';
import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;

type Reply = Awaited<ReturnType<SetupFixture['call']>>;
const json = (res: Reply) => res.json<Json>();
const setupAudit = (action: string) =>
  f.inTenant((tx) => tx.prisma.setupAudit.findMany({ where: { action } }));
const outboxTopics = (topic: string) =>
  f.inTenant((tx) => tx.prisma.outboxEvent.findMany({ where: { topic } }));
const place = (user: string, orgUnitId: string | null) =>
  f.inTenant(async (tx) => {
    await tx.prisma.user.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: f.id(user) } },
      data: { orgUnitId },
    });
    await visibility.rebuild(tx);
  });
const sees = (viewer: string) => f.inTenant((tx) => visibility.ownersVisibleTo(tx, f.id(viewer)));

async function create(url: string, payload: Json): Promise<Json & { id: string; version: number }> {
  const res = await f.call('admin', 'POST', url, payload);
  expect(res.statusCode, `${url} ${res.body}`).toBe(201);
  return res.json<Json & { id: string; version: number }>();
}

beforeAll(async () => {
  f = await setupFixture('people');
});

afterAll(async () => {
  await f.api.dispose();
});

describe('/v1/org-units (§6.3)', () => {
  it('creates a tree and lists it with user counts', async () => {
    const top = await create('/v1/org-units', { name: 'Company' });
    const sales = await create('/v1/org-units', { name: 'Sales', parentId: top.id });
    const east = await create('/v1/org-units', { name: 'East', parentId: sales.id });
    const ops = await create('/v1/org-units', { name: 'Operations', parentId: top.id });
    for (const [k, v] of Object.entries({ top, sales, east, ops })) f.set(`unit:${k}`, v.id);
    await place('peer', f.id('unit:ops'));
    await place('rep', f.id('unit:east'));
    const list = (await f.call('viewer', 'GET', '/v1/org-units')).json<{
      items: { name: string; parentId: string | null; users: number }[];
    }>();
    expect(list.items.map((u) => [u.name, u.users])).toEqual([
      ['Company', 0],
      ['East', 1],
      ['Operations', 1],
      ['Sales', 0],
    ]);
    expect((await setupAudit('org_unit.created')).length).toBe(4);
  });

  it('moves a subtree, rebuilding who sees it and recalculating owner rules', async () => {
    expect(await sees('peer')).not.toContain(f.id('rep'));
    const east = (await f.call('admin', 'GET', `/v1/org-units/${f.id('unit:east')}`)).json<{
      version: number;
    }>();
    // Move East under Operations: peer (in Operations) now sits above rep.
    const res = await f.call('admin', 'PATCH', `/v1/org-units/${f.id('unit:east')}`, {
      version: east.version,
      parentId: f.id('unit:ops'),
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ parentId: f.id('unit:ops'), version: east.version + 1 });
    expect(await sees('peer')).toContain(f.id('rep'));
    expect(await setupAudit('org_unit.moved')).toHaveLength(1);
  });

  it('refuses cycles, stale versions and unknown parents', async () => {
    const top = (await f.call('admin', 'GET', `/v1/org-units/${f.id('unit:top')}`)).json<{
      version: number;
    }>();
    const cycle = await f.call('admin', 'PATCH', `/v1/org-units/${f.id('unit:top')}`, {
      version: top.version,
      parentId: f.id('unit:east'),
    });
    expect(cycle.statusCode).toBe(409);
    const stale = await f.call('admin', 'PATCH', `/v1/org-units/${f.id('unit:top')}`, {
      version: top.version + 5,
      name: 'X',
    });
    expect(json(stale)).toMatchObject({ code: 'version_conflict' });
    const orphan = await f.call('admin', 'POST', '/v1/org-units', {
      name: 'Nowhere',
      parentId: '00000000-0000-7000-8000-000000000000',
    });
    expect(orphan.statusCode).toBe(400);
    expect((await f.call('admin', 'POST', '/v1/org-units', { name: '' })).statusCode).toBe(400);
  });

  it('deletes only an empty unit', async () => {
    const del = (unit: string) => f.call('admin', 'DELETE', `/v1/org-units/${f.id(unit)}`);
    expect((await del('unit:top')).statusCode).toBe(409); // has units below it
    expect((await del('unit:east')).statusCode).toBe(409); // rep sits in it
    expect((await del('unit:sales')).statusCode).toBe(204); // empty since East moved
    expect((await f.call('admin', 'GET', `/v1/org-units/${f.id('unit:sales')}`)).statusCode).toBe(
      404,
    );
    expect(await setupAudit('org_unit.deleted')).toHaveLength(1);
  });

  it('is guarded: view_setup reads, manage_users changes, other workspaces get 404', async () => {
    const unit = f.id('unit:top');
    await f.expectGuarded('GET', '/v1/org-units', {});
    await f.expectGuarded('GET', `/v1/org-units/${unit}`, {});
    await f.expectGuarded('POST', '/v1/org-units', { payload: { name: 'N' } });
    await f.expectGuarded('PATCH', `/v1/org-units/${unit}`, { payload: { version: 1 } });
    await f.expectGuarded('DELETE', `/v1/org-units/${unit}`, {});
  });
});

describe('/v1/groups (§6.3)', () => {
  it('creates nested groups whose user count is transitive', async () => {
    const field = await create('/v1/groups', {
      name: 'Field team',
      members: [
        { type: 'USER', id: f.id('rep') },
        { type: 'ORG_UNIT_AND_SUBORDINATES', id: f.id('unit:ops') },
      ],
    });
    // rep (East) and peer (Operations) are both inside Operations' subtree now.
    expect(field).toMatchObject({ userCount: 2 });
    const all = await create('/v1/groups', {
      name: 'Everyone in the field',
      members: [{ type: 'GROUP', id: field.id }],
    });
    expect(all).toMatchObject({
      userCount: 2,
      members: [{ type: 'GROUP', id: field.id, name: 'Field team' }],
    });
    f.set('group:field', field.id);
    f.set('group:all', all.id);
  });

  it('refuses a cycle, a taken name and unknown members', async () => {
    const field = (await f.call('admin', 'GET', `/v1/groups/${f.id('group:field')}`)).json<{
      version: number;
    }>();
    const cycle = await f.call('admin', 'PATCH', `/v1/groups/${f.id('group:field')}`, {
      version: field.version,
      members: [{ type: 'GROUP', id: f.id('group:all') }],
    });
    expect(cycle.statusCode).toBe(409);
    expect(
      (await f.call('admin', 'POST', '/v1/groups', { name: 'Field team', members: [] })).statusCode,
    ).toBe(409);
    const unknown = await f.call('admin', 'POST', '/v1/groups', {
      name: 'Ghosts',
      members: [{ type: 'USER', id: '00000000-0000-7000-8000-000000000000' }],
    });
    expect(unknown.statusCode).toBe(400);
    expect(
      (await f.call('admin', 'POST', '/v1/groups', { name: 'X', members: [{ type: 'ROBOT' }] }))
        .statusCode,
    ).toBe(400);
  });

  it('recalculates owner rules when membership changes, and audits it', async () => {
    await f.inTenant((tx) =>
      tx.prisma.sharingRule.create({
        data: {
          tenantId: f.tenantId,
          object: 'account',
          name: 'Field shares with all',
          kind: 'OWNER',
          sourceType: 'GROUP',
          sourceId: f.id('group:field'),
          targetType: 'GROUP',
          targetId: f.id('group:all'),
          access: 1,
        },
      }),
    );
    const before = (await outboxTopics('sharing.rule_changed')).length;
    const field = (await f.call('admin', 'GET', `/v1/groups/${f.id('group:field')}`)).json<{
      version: number;
    }>();
    const res = await f.call('admin', 'PATCH', `/v1/groups/${f.id('group:field')}`, {
      version: field.version,
      members: [{ type: 'USER', id: f.id('rep') }],
    });
    expect(json(res)).toMatchObject({ userCount: 1, version: field.version + 1 });
    expect((await outboxTopics('sharing.rule_changed')).length).toBe(before + 1);
    const [audited] = await setupAudit('group.updated');
    expect(audited?.before).toMatchObject({ members: expect.any(Array) as unknown });
  });

  it('deletes a group only once nothing refers to it', async () => {
    const del = (g: string) => f.call('admin', 'DELETE', `/v1/groups/${f.id(g)}`);
    expect((await del('group:field')).statusCode).toBe(409); // inside "Everyone", and in a rule
    expect((await del('group:all')).statusCode).toBe(409); // the rule's target
    await f.inTenant((tx) => tx.prisma.sharingRule.deleteMany());
    expect((await del('group:all')).statusCode).toBe(204);
    expect((await del('group:field')).statusCode).toBe(204);
  });

  it('is guarded', async () => {
    const group = await create('/v1/groups', { name: 'Guarded', members: [] });
    await f.expectGuarded('GET', '/v1/groups', {});
    await f.expectGuarded('GET', `/v1/groups/${group.id}`, {});
    await f.expectGuarded('POST', '/v1/groups', { payload: { name: 'N', members: [] } });
    await f.expectGuarded('PATCH', `/v1/groups/${group.id}`, { payload: { version: 1 } });
    await f.expectGuarded('DELETE', `/v1/groups/${group.id}`, {});
  });
});

describe('/v1/queues (§6.3)', () => {
  it('gives members sight of queue-owned records, and takes it away again', async () => {
    const queue = await create('/v1/queues', {
      name: 'Inbound leads',
      email: 'inbound@people.test',
      objects: ['lead', 'lead'],
      members: [{ type: 'USER', id: f.id('rep') }],
    });
    expect(queue).toMatchObject({ objects: ['lead'], userCount: 1 });
    expect(await sees('rep')).toContain(queue.id);
    const res = await f.call('admin', 'PATCH', `/v1/queues/${queue.id}`, {
      version: queue.version,
      members: [{ type: 'USER', id: f.id('peer') }],
      objects: ['lead', 'activity'],
    });
    expect(json(res)).toMatchObject({ objects: ['activity', 'lead'], userCount: 1 });
    expect(await sees('rep')).not.toContain(queue.id);
    expect(await sees('peer')).toContain(queue.id);
    f.set('queue', queue.id);
  });

  it('refuses unknown objects, no objects and taken names', async () => {
    const post = (payload: Json) => f.call('admin', 'POST', '/v1/queues', payload);
    expect((await post({ name: 'Q', objects: ['widget'], members: [] })).statusCode).toBe(400);
    expect((await post({ name: 'Q', objects: [], members: [] })).statusCode).toBe(400);
    expect((await post({ name: 'Inbound leads', objects: ['lead'], members: [] })).statusCode).toBe(
      409,
    );
  });

  it('deletes a queue and its members lose sight of it', async () => {
    expect((await f.call('admin', 'DELETE', `/v1/queues/${f.id('queue')}`)).statusCode).toBe(204);
    expect(await sees('peer')).not.toContain(f.id('queue'));
    expect(await setupAudit('queue.deleted')).toHaveLength(1);
  });

  it('is guarded', async () => {
    const queue = await create('/v1/queues', { name: 'Guarded', objects: ['lead'], members: [] });
    await f.expectGuarded('GET', '/v1/queues', {});
    await f.expectGuarded('GET', `/v1/queues/${queue.id}`, {});
    await f.expectGuarded('POST', '/v1/queues', {
      payload: { name: 'N', objects: ['lead'], members: [] },
    });
    await f.expectGuarded('PATCH', `/v1/queues/${queue.id}`, { payload: { version: 1 } });
    await f.expectGuarded('DELETE', `/v1/queues/${queue.id}`, {});
  });
});

const effective = (user: string) =>
  f.inTenant((tx) => f.api.app.get(PermissionService).forUser(tx, f.id(user)));

describe('/v1/profiles (§6.2)', () => {
  it('lists the built-in profiles with their users', async () => {
    const list = (await f.call('viewer', 'GET', '/v1/profiles')).json<{
      items: { systemKey: string | null; users: number }[];
    }>();
    expect(Object.fromEntries(list.items.map((p) => [p.systemKey, p.users]))).toEqual({
      system_administrator: 1,
      standard_user: 3,
      read_only: 0,
    });
  });

  it('clones a profile, and new grants take effect on the next request', async () => {
    const profile = await create('/v1/profiles', {
      name: 'Field rep',
      cloneFrom: f.id('profile:standard'),
    });
    const standard = (
      await f.call('admin', 'GET', `/v1/profiles/${f.id('profile:standard')}`)
    ).json<{ grants: unknown }>();
    expect(profile['grants']).toEqual(standard.grants);
    await f.inTenant((tx) =>
      tx.prisma.user.update({
        where: { tenantId_id: { tenantId: f.tenantId, id: f.id('peer') } },
        data: { profileId: profile.id },
      }),
    );
    expect((await effective('peer')).system.has('export_reports')).toBe(false);
    const res = await f.call('admin', 'PUT', `/v1/profiles/${profile.id}/grants`, {
      version: profile.version,
      grants: {
        system: ['export_reports'],
        objects: {
          lead: {
            read: false,
            create: false,
            edit: true,
            delete: false,
            viewAll: false,
            modifyAll: false,
          },
        },
        fields: { lead: { phone: { read: false, edit: true } } },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Dependencies are closed: edit brings read along, for objects and fields alike.
    expect(json(res)).toMatchObject({
      grants: {
        system: ['export_reports'],
        objects: { lead: { read: true, edit: true, create: false } },
        fields: { lead: { phone: { read: true, edit: true } } },
      },
    });
    const peer = await effective('peer');
    expect(peer.system.has('export_reports')).toBe(true);
    expect(peer.objects['account']).toBeUndefined();
    expect(await setupAudit('profile.grants_changed')).toHaveLength(1);
    f.set('profile:field', profile.id);
  });

  it('validates grants against the catalogue', async () => {
    const put = (grants: Json) =>
      f.call('admin', 'PUT', `/v1/profiles/${f.id('profile:field')}/grants`, {
        version: 2,
        grants: { system: [], objects: {}, fields: {}, ...grants },
      });
    expect((await put({ system: ['launch_rockets'] })).statusCode).toBe(400);
    expect((await put({ fields: { lead: { id: { read: true, edit: true } } } })).statusCode).toBe(
      400,
    ); // a system field is outside FLS
    expect(
      (
        await put({
          objects: {
            widget: {
              read: true,
              create: false,
              edit: false,
              delete: false,
              viewAll: false,
              modifyAll: false,
            },
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('protects built-in profiles and profiles in use', async () => {
    const admin = (await f.call('admin', 'GET', `/v1/profiles/${f.id('profile:admin')}`)).json<{
      version: number;
    }>();
    const lockout = await f.call('admin', 'PUT', `/v1/profiles/${f.id('profile:admin')}/grants`, {
      version: admin.version,
      grants: { system: [], objects: {}, fields: {} },
    });
    expect(lockout.statusCode).toBe(409);
    const del = (p: string) => f.call('admin', 'DELETE', `/v1/profiles/${f.id(p)}`);
    expect((await del('profile:readonly')).statusCode).toBe(409);
    expect((await del('profile:field')).statusCode).toBe(409); // peer uses it
    const renamed = await f.call('admin', 'PATCH', `/v1/profiles/${f.id('profile:field')}`, {
      version: 2,
      name: 'Field sales',
    });
    expect(json(renamed)).toMatchObject({ name: 'Field sales', version: 3 });
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/profiles/${f.id('profile:field')}`, {
          version: 3,
          name: 'Standard User',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('is guarded', async () => {
    const p = f.id('profile:field');
    await f.expectGuarded('GET', '/v1/profiles', {});
    await f.expectGuarded('GET', `/v1/profiles/${p}`, {});
    await f.expectGuarded('POST', '/v1/profiles', { payload: { name: 'N' } });
    await f.expectGuarded('PATCH', `/v1/profiles/${p}`, { payload: { version: 1 } });
    await f.expectGuarded('PUT', `/v1/profiles/${p}/grants`, {
      payload: { version: 1, grants: { system: [], objects: {}, fields: {} } },
    });
    await f.expectGuarded('DELETE', `/v1/profiles/${p}`, {});
  });
});

describe('/v1/permission-sets and /v1/permission-set-groups (§6.2)', () => {
  const leadFull = {
    read: true,
    create: true,
    edit: true,
    delete: true,
    viewAll: false,
    modifyAll: false,
  };

  it('creates sets, groups them, and mutes one flag for the group only', async () => {
    const leads = await create('/v1/permission-sets', {
      name: 'Lead desk',
      grants: { system: ['import_records'], objects: { lead: leadFull }, fields: {} },
    });
    const exports = await create('/v1/permission-sets', {
      name: 'Exporter',
      grants: { system: ['export_reports'], objects: {}, fields: {} },
    });
    const group = await create('/v1/permission-set-groups', {
      name: 'Lead desk (no delete)',
      permissionSetIds: [leads.id, exports.id],
      muting: {
        system: ['export_reports'],
        objects: {
          lead: {
            read: false,
            create: false,
            edit: false,
            delete: true,
            viewAll: false,
            modifyAll: false,
          },
        },
        fields: {},
      },
    });
    expect(group).toMatchObject({
      permissionSets: [
        { id: exports.id, name: 'Exporter' },
        { id: leads.id, name: 'Lead desk' },
      ],
      muting: { system: ['export_reports'], objects: { lead: { delete: true, edit: false } } },
    });
    await f.inTenant((tx) =>
      tx.prisma.permissionAssignment.create({
        data: { tenantId: f.tenantId, userId: f.id('rep'), permissionSetGroupId: group.id },
      }),
    );
    const rep = await effective('rep');
    expect(rep.system.has('import_records')).toBe(true);
    // Standard User grants lead delete by profile: muting only removes what the group grants.
    expect(rep.objects['lead']?.delete).toBe(true);
    expect(rep.system.has('export_reports')).toBe(false);
    f.set('set:leads', leads.id);
    f.set('psg', group.id);
  });

  it('counts assignments and refuses to delete what is in use', async () => {
    const set = (await f.call('viewer', 'GET', `/v1/permission-sets/${f.id('set:leads')}`)).json<{
      assignedUsers: number;
      groups: number;
    }>();
    expect(set).toMatchObject({ assignedUsers: 0, groups: 1 });
    expect(
      (await f.call('admin', 'DELETE', `/v1/permission-sets/${f.id('set:leads')}`)).statusCode,
    ).toBe(409);
    expect(
      (await f.call('admin', 'DELETE', `/v1/permission-set-groups/${f.id('psg')}`)).statusCode,
    ).toBe(409);
    const list = (await f.call('admin', 'GET', '/v1/permission-sets')).json<{
      items: { name: string }[];
    }>();
    expect(list.items.map((s) => s.name)).toEqual(['Exporter', 'Lead desk', 'Setup viewer']);
  });

  it('clears a muting set, replaces grants and validates references', async () => {
    const group = (await f.call('admin', 'GET', `/v1/permission-set-groups/${f.id('psg')}`)).json<{
      version: number;
    }>();
    const cleared = await f.call('admin', 'PATCH', `/v1/permission-set-groups/${f.id('psg')}`, {
      version: group.version,
      muting: null,
    });
    expect(json(cleared)).toMatchObject({ muting: null });
    expect((await effective('rep')).system.has('export_reports')).toBe(true);
    const unknown = await f.call('admin', 'POST', '/v1/permission-set-groups', {
      name: 'Bad',
      permissionSetIds: [f.id('profile:standard')],
    });
    expect(unknown.statusCode).toBe(400);
    const set = (await f.call('admin', 'GET', `/v1/permission-sets/${f.id('set:leads')}`)).json<{
      version: number;
    }>();
    const put = await f.call('admin', 'PUT', `/v1/permission-sets/${f.id('set:leads')}/grants`, {
      version: set.version,
      grants: { system: [], objects: {}, fields: {} },
    });
    expect(json(put)).toMatchObject({ grants: { system: [], objects: {} } });
    expect((await effective('rep')).system.has('import_records')).toBe(false);
    expect(
      (
        await f.call('admin', 'POST', '/v1/permission-sets', {
          name: 'Exporter',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('is guarded', async () => {
    const s = f.id('set:leads');
    const g = f.id('psg');
    const empty = { system: [], objects: {}, fields: {} };
    await f.expectGuarded('GET', '/v1/permission-sets', {});
    await f.expectGuarded('GET', `/v1/permission-sets/${s}`, {});
    await f.expectGuarded('POST', '/v1/permission-sets', { payload: { name: 'N' } });
    await f.expectGuarded('PATCH', `/v1/permission-sets/${s}`, { payload: { version: 1 } });
    await f.expectGuarded('PUT', `/v1/permission-sets/${s}/grants`, {
      payload: { version: 1, grants: empty },
    });
    await f.expectGuarded('DELETE', `/v1/permission-sets/${s}`, {});
    await f.expectGuarded('GET', '/v1/permission-set-groups', {});
    await f.expectGuarded('GET', `/v1/permission-set-groups/${g}`, {});
    await f.expectGuarded('POST', '/v1/permission-set-groups', {
      payload: { name: 'N', permissionSetIds: [] },
    });
    await f.expectGuarded('PATCH', `/v1/permission-set-groups/${g}`, { payload: { version: 1 } });
    await f.expectGuarded('DELETE', `/v1/permission-set-groups/${g}`, {});
  });
});
