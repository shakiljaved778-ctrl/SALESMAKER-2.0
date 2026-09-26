import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
type Reply = Awaited<ReturnType<SetupFixture['call']>>;
const json = (res: Reply) => res.json<Json>();
const outbox = (topic: string) =>
  f.inTenant((tx) =>
    tx.prisma.outboxEvent.findMany({ where: { topic }, orderBy: [{ createdAt: 'asc' }] }),
  );

beforeAll(async () => {
  f = await setupFixture('sharing', { recordTables: (object) => `fx_${object}` });
  const migrator = new pg.Client({ connectionString: f.api.db.migratorUrl });
  await migrator.connect();
  await migrator.query(`
    CREATE TABLE fx_account (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
      owner_id uuid NOT NULL, name text NOT NULL, industry text, PRIMARY KEY (tenant_id, id));
    CREATE TABLE fx_contact (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
      owner_id uuid NOT NULL, last_name text NOT NULL, account_id uuid, PRIMARY KEY (tenant_id, id));
    SELECT enable_tenant_rls('fx_account');
    SELECT enable_tenant_rls('fx_contact');`);
  await migrator.end();
  await f.inTenant(async (tx) => {
    const [acc] = await tx.kysely
      .insertInto('fx_account')
      .values({ tenant_id: f.tenantId, owner_id: f.id('rep'), name: 'Acme', industry: 'Energy' })
      .returning('id')
      .execute();
    f.set('acc', String(acc?.['id']));
    const [contact] = await tx.kysely
      .insertInto('fx_contact')
      .values({ tenant_id: f.tenantId, owner_id: f.id('rep'), last_name: 'Doe' })
      .returning('id')
      .execute();
    f.set('contact', String(contact?.['id']));
    const unit = await tx.prisma.orgUnit.create({ data: { tenantId: f.tenantId, name: 'Sales' } });
    f.set('unit', unit.id);
    const group = await tx.prisma.publicGroup.create({
      data: { tenantId: f.tenantId, name: 'Analysts' },
    });
    f.set('group', group.id);
  });
});

afterAll(async () => {
  await f.api.dispose();
});

describe('/v1/sharing/owd (§6.3)', () => {
  it('lists every standard object with its default and the models it allows', async () => {
    const res = await f.call('viewer', 'GET', '/v1/sharing/owd');
    const items = res.json<{ items: Json[] }>().items;
    expect(items).toHaveLength(10);
    expect(items.find((o) => o['object'] === 'account')).toEqual({
      object: 'account',
      sharingModel: 'PRIVATE',
      grantHierarchy: true,
      allowedModels: ['PRIVATE', 'PUBLIC_READ', 'PUBLIC_READ_WRITE'],
      hierarchyEditable: false,
    });
  });

  it('changes a default, which takes effect on the next read', async () => {
    const peerSees = async () =>
      (await f.call('peer', 'GET', `/v1/me/access/account/${f.id('acc')}`)).statusCode;
    expect(await peerSees()).toBe(404);
    const res = await f.call('admin', 'PUT', '/v1/sharing/owd/account', {
      sharingModel: 'PUBLIC_READ',
    });
    expect(json(res)).toMatchObject({ sharingModel: 'PUBLIC_READ' });
    expect(await peerSees()).toBe(200);
    await f.call('admin', 'PUT', '/v1/sharing/owd/account', { sharingModel: 'PRIVATE' });
    expect(await peerSees()).toBe(404);
    const audited = await f.inTenant((tx) =>
      tx.prisma.setupAudit.count({ where: { action: 'sharing.owd_changed' } }),
    );
    expect(audited).toBe(2);
  });

  it('refuses models the object does not allow, hierarchy opt-outs and unknown objects', async () => {
    const put = (object: string, payload: Json) =>
      f.call('admin', 'PUT', `/v1/sharing/owd/${object}`, payload);
    expect((await put('account', { sharingModel: 'CONTROLLED_BY_PARENT' })).statusCode).toBe(400);
    expect(
      (await put('account', { sharingModel: 'PRIVATE', grantHierarchy: false })).statusCode,
    ).toBe(400);
    expect((await put('account', { sharingModel: 'SECRET' })).statusCode).toBe(400);
    expect((await put('widget', { sharingModel: 'PRIVATE' })).statusCode).toBe(404);
  });

  it('is guarded: reading needs view_setup, changing customize_application', async () => {
    await f.expectGuarded('GET', '/v1/sharing/owd', {});
    await f.expectGuarded('PUT', '/v1/sharing/owd/account', {
      payload: { sharingModel: 'PRIVATE' },
    });
    // Another workspace changing "its" account default leaves ours alone.
    await f.call('outsider', 'PUT', '/v1/sharing/owd/account', { sharingModel: 'PUBLIC_READ' });
    const ours = (await f.call('admin', 'GET', '/v1/sharing/owd')).json<{ items: Json[] }>();
    expect(ours.items.find((o) => o['object'] === 'account')?.['sharingModel']).toBe('PRIVATE');
  });
});

describe('/v1/sharing/rules (§6.3, §6.4)', () => {
  it('creates an owner rule and queues its recalculation, tracked by a job run', async () => {
    const res = await f.call('admin', 'POST', '/v1/sharing/rules', {
      object: 'account',
      name: 'Sales shares with analysts',
      kind: 'OWNER',
      source: { type: 'ORG_UNIT_AND_SUBORDINATES', id: f.id('unit') },
      target: { type: 'GROUP', id: f.id('group') },
      access: 'read',
    });
    expect(res.statusCode, res.body).toBe(201);
    const rule = res.json<{
      id: string;
      version: number;
      lastRun: { id: string; status: string };
    }>();
    expect(rule).toMatchObject({
      source: { type: 'ORG_UNIT_AND_SUBORDINATES', id: f.id('unit'), name: 'Sales' },
      target: { type: 'GROUP', name: 'Analysts' },
      access: 'read',
      active: true,
      lastRun: { status: 'QUEUED', done: 0, total: null },
    });
    const [event] = await outbox('sharing.rule_changed');
    expect(event?.payload).toEqual({ ruleId: rule.id, jobRunId: rule.lastRun.id });
    f.set('rule', rule.id);
  });

  it('creates a criteria rule over the object’s own fields only', async () => {
    const post = (criteria: unknown, name = 'Energy accounts') =>
      f.call('admin', 'POST', '/v1/sharing/rules', {
        object: 'account',
        name,
        kind: 'CRITERIA',
        criteria,
        target: { type: 'ORG_UNIT', id: f.id('unit') },
        access: 'edit',
      });
    expect((await post({ field: 'salary', op: 'eq', value: 1 })).statusCode).toBe(400);
    expect((await post({ field: 'industry', op: 'explode', value: 1 })).statusCode).toBe(400);
    const ok = await post({ field: 'industry', op: 'eq', value: 'Energy' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(json(ok)).toMatchObject({ kind: 'CRITERIA', access: 'edit', source: null });
    expect((await post({ field: 'industry', op: 'eq', value: 'Energy' })).statusCode).toBe(409);
  });

  it('checks the rule’s shape, principals and object', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/sharing/rules', {
        object: 'account',
        name: 'Shape',
        kind: 'OWNER',
        target: { type: 'GROUP', id: f.id('group') },
        access: 'read',
        ...payload,
      });
    expect((await post({})).statusCode).toBe(400); // an owner rule needs a source
    expect(
      (await post({ source: { type: 'GROUP', id: '00000000-0000-7000-8000-000000000000' } }))
        .statusCode,
    ).toBe(400);
    expect((await post({ source: { type: 'USER', id: f.id('rep') } })).statusCode).toBe(400); // users are not rule sources
    expect(
      (await post({ object: 'contact', source: { type: 'GROUP', id: f.id('group') } })).statusCode,
    ).toBe(400); // contacts are controlled by their parent account
  });

  it('recalculates when what the rule shares changes, not when it is renamed', async () => {
    const runs = async () =>
      f.inTenant((tx) => tx.prisma.jobRun.count({ where: { subjectId: f.id('rule') } }));
    const url = `/v1/sharing/rules/${f.id('rule')}`;
    const renamed = await f.call('admin', 'PATCH', url, { version: 1, name: 'Renamed' });
    expect(json(renamed)).toMatchObject({ name: 'Renamed', version: 2 });
    expect(await runs()).toBe(1);
    const widened = await f.call('admin', 'PATCH', url, { version: 2, access: 'edit' });
    expect(json(widened)).toMatchObject({ access: 'edit', version: 3 });
    expect(await runs()).toBe(2);
    expect((await f.call('admin', 'PATCH', url, { version: 2, active: false })).statusCode).toBe(
      409,
    );
    expect(
      (
        await f.call('admin', 'PATCH', url, {
          version: 3,
          criteria: { field: 'name', op: 'eq', value: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('lists rules and deletes one, queueing removal of its shares', async () => {
    const list = (await f.call('viewer', 'GET', '/v1/sharing/rules')).json<{
      items: { name: string }[];
    }>();
    expect(list.items.map((r) => r.name)).toEqual(['Energy accounts', 'Renamed']);
    expect((await f.call('admin', 'DELETE', `/v1/sharing/rules/${f.id('rule')}`)).statusCode).toBe(
      204,
    );
    const [removed] = await outbox('sharing.rule_deleted');
    expect(removed?.payload).toEqual({ ruleId: f.id('rule'), object: 'account' });
    expect((await f.call('admin', 'GET', `/v1/sharing/rules/${f.id('rule')}`)).statusCode).toBe(
      404,
    );
  });

  it('is guarded', async () => {
    const rule = (await f.call('admin', 'GET', '/v1/sharing/rules')).json<{
      items: { id: string }[];
    }>().items[0]?.id;
    const url = `/v1/sharing/rules/${rule ?? ''}`;
    await f.expectGuarded('GET', '/v1/sharing/rules', {});
    await f.expectGuarded('GET', url, {});
    await f.expectGuarded('POST', '/v1/sharing/rules', { payload: { object: 'account' } });
    await f.expectGuarded('PATCH', url, { payload: { version: 1 } });
    await f.expectGuarded('DELETE', url, {});
  });
});

describe('/v1/records/{object}/{id}/share (§6.3 manual sharing)', () => {
  const url = () => `/v1/records/account/${f.id('acc')}/share`;

  it('lets the owner share a record, and the recipient then sees it', async () => {
    expect((await f.call('peer', 'GET', `/v1/me/access/account/${f.id('acc')}`)).statusCode).toBe(
      404,
    );
    const res = await f.call('rep', 'POST', url(), {
      principal: { type: 'USER', id: f.id('peer') },
      access: 'read',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: Json[] }>().items).toEqual([
      {
        principal: { type: 'USER', id: f.id('peer'), name: 'peer' },
        access: 'read',
        reason: 'MANUAL',
        sourceId: null,
      },
    ]);
    expect((await f.call('peer', 'GET', `/v1/me/access/account/${f.id('acc')}`)).statusCode).toBe(
      200,
    );
    // Sharing again changes the level instead of adding a second share.
    const edit = await f.call('rep', 'POST', url(), {
      principal: { type: 'USER', id: f.id('peer') },
      access: 'edit',
    });
    expect(edit.json<{ items: Json[] }>().items).toMatchObject([{ access: 'edit' }]);
    const audited = await f.inTenant((tx) =>
      tx.prisma.auditLog.count({ where: { action: 'record.shared', recordId: f.id('acc') } }),
    );
    expect(audited).toBe(2);
  });

  it('needs Full access: a recipient with Read-Write gets 403, a stranger 404', async () => {
    expect((await f.call('peer', 'GET', url())).statusCode).toBe(403);
    expect(
      (
        await f.call('peer', 'POST', url(), {
          principal: { type: 'USER', id: f.id('viewer') },
          access: 'read',
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.call('viewer', 'GET', url())).statusCode).toBe(404);
    expect((await f.call('outsider', 'GET', url())).statusCode).toBe(404);
    expect((await f.call('admin', 'GET', url())).statusCode).toBe(200); // Modify All
  });

  it('validates the request and the principal', async () => {
    const post = (payload: Json) => f.call('rep', 'POST', url(), payload);
    expect(
      (await post({ principal: { type: 'USER', id: f.id('peer') }, access: 'full' })).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          principal: { type: 'GROUP', id: '00000000-0000-7000-8000-000000000000' },
          access: 'read',
        })
      ).statusCode,
    ).toBe(400);
    expect((await f.call('rep', 'GET', '/v1/records/account/nope/share')).statusCode).toBe(400);
    expect(
      (await f.call('rep', 'GET', '/v1/records/widget/00000000-0000-7000-8000-000000000000/share'))
        .statusCode,
    ).toBe(404);
  });

  it('refuses manual shares where the parent controls access', async () => {
    const res = await f.call('rep', 'POST', `/v1/records/contact/${f.id('contact')}/share`, {
      principal: { type: 'USER', id: f.id('peer') },
      access: 'read',
    });
    expect(res.statusCode).toBe(409);
  });

  it('removes a manual share; removing it again is a 404', async () => {
    const revoke = () =>
      f.call('rep', 'DELETE', `${url()}?principalType=USER&principalId=${f.id('peer')}`);
    expect((await revoke()).statusCode).toBe(204);
    expect((await f.call('peer', 'GET', `/v1/me/access/account/${f.id('acc')}`)).statusCode).toBe(
      404,
    );
    expect((await revoke()).statusCode).toBe(404);
    expect((await f.call('rep', 'DELETE', `${url()}?principalType=USER`)).statusCode).toBe(400);
  });
});
